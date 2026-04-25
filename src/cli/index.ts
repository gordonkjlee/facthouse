#!/usr/bin/env node

/**
 * OpenMemory CLI entry point.
 * Subcommands: log-event, consolidate
 */

import { parseArgs } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { logEvent, extractContentFromHookPayload } from "./log-event.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { applySchema } from "../db/schema.js";
import { consolidate } from "../intelligence/consolidate.js";
import { createHeuristicProvider } from "../intelligence/heuristic.js";
import { DEFAULT_CONFIG } from "../types/config.js";
import { sendSchedulerSignal, type SignalKind } from "../ipc/scheduler-ipc.js";

const DEFAULT_DATA_DIR = path.join(homedir(), ".openmemory");

function resolveTilde(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);

    // Don't hang if stdin is a TTY with no data.
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

async function main() {
  // Recursion guard: any subprocess-based intelligence provider that
  // re-invokes an MCP client should set OPENMEMORY_SUBPROCESS=1 in the
  // child's env. If a surviving hook then re-enters this CLI, we must
  // not log events or signal the scheduler — both would feed back into
  // an extraction loop. Exit silently with success.
  if (process.env.OPENMEMORY_SUBPROCESS === "1") {
    process.exit(0);
  }

  const subcommand = process.argv[2];

  if (subcommand === "log-event") {
    await runLogEvent();
  } else if (subcommand === "consolidate") {
    await runConsolidate();
  } else if (subcommand === "signal") {
    await runSignal();
  } else {
    console.error(
      `Usage: openmemory <command>\n\n` +
        `Commands:\n` +
        `  log-event     Log a session event (used by hooks)\n` +
        `  signal        Signal the running MCP server to tick or flush\n` +
        `  consolidate   Run consolidation in-process with the heuristic provider`,
    );
    process.exit(1);
  }
}

async function runSignal() {
  const kindArg = process.argv[3] ?? "tick";
  const { values } = parseArgs({
    args: process.argv.slice(4),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? DEFAULT_DATA_DIR },
    },
    strict: true,
  });

  if (kindArg !== "tick" && kindArg !== "flush") {
    console.error(`Invalid signal kind: ${kindArg}. Expected 'tick' or 'flush'.`);
    process.exit(1);
  }
  const kind = kindArg as SignalKind;
  const dataDir = resolveTilde(values.data as string);

  const delivered = await sendSchedulerSignal(dataDir, kind);
  if (delivered) {
    console.log(JSON.stringify({ delivered: true, kind }));
    return;
  }

  // Fallback only for 'flush' — matches the PreCompact "don't lose data"
  // contract. For 'tick' (routine log-event signals), a missed delivery
  // is recovered by session_start on the next launch.
  if (kind === "flush") {
    console.error(
      "[openmemory] Server unreachable; running heuristic consolidate in-process as fallback.",
    );
    await consolidateInProcess(dataDir);
    return;
  }

  // 'tick' delivery failed — silent exit. Don't spawn fallback work.
  console.log(JSON.stringify({ delivered: false, kind }));
}

async function runConsolidate() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? DEFAULT_DATA_DIR },
    },
    strict: true,
  });
  const dataDir = resolveTilde(values.data as string);
  await consolidateInProcess(dataDir);
}

/**
 * Open the DB at dataDir, run consolidate() with the heuristic provider,
 * print the JSON result, then close. Used by both `openmemory consolidate`
 * and the `signal flush` fallback when the server is unreachable.
 *
 * Taking dataDir as a parameter (rather than re-parsing process.argv) lets
 * callers invoke this from contexts where argv contains positional args the
 * parser doesn't expect (e.g. signal flush's own `flush` positional).
 */
export async function consolidateInProcess(dataDir: string): Promise<void> {
  const dbPath = path.join(dataDir, "memory.db");
  const db = openDatabase(dbPath);

  try {
    applySchema(db);
    const result = await consolidate(db, createHeuristicProvider(), DEFAULT_CONFIG);
    console.log(JSON.stringify(result));
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  } finally {
    closeDatabase(db);
  }
}

async function runLogEvent() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      role: { type: "string", default: "user" },
      "event-type": { type: "string", default: "message" },
      "content-type": { type: "string", default: "text" },
      content: { type: "string" },
      "session-id": { type: "string" },
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? DEFAULT_DATA_DIR },
    },
    strict: true,
  });

  const role = values.role as string;
  const eventType = values["event-type"] as string;
  const contentType = values["content-type"] as string;

  // Validate role.
  const validRoles = ["user", "assistant", "system", "tool"];
  if (!validRoles.includes(role)) {
    console.error(`Invalid --role: ${role}. Must be one of: ${validRoles.join(", ")}`);
    process.exit(1);
  }

  // Validate event-type.
  const validEventTypes = ["message", "tool_call", "tool_result", "artifact"];
  if (!validEventTypes.includes(eventType)) {
    console.error(
      `Invalid --event-type: ${eventType}. Must be one of: ${validEventTypes.join(", ")}`,
    );
    process.exit(1);
  }

  // Validate content-type.
  const validContentTypes = ["text", "json", "image", "audio", "binary"];
  if (!validContentTypes.includes(contentType)) {
    console.error(
      `Invalid --content-type: ${contentType}. Must be one of: ${validContentTypes.join(", ")}`,
    );
    process.exit(1);
  }

  // Content from --content flag or stdin (for hooks).
  let content = values.content as string | undefined;
  let sessionId = values["session-id"] as string | undefined;

  if (!content) {
    const stdin = await readStdin();
    if (stdin.trim()) {
      const extracted = extractContentFromHookPayload(stdin.trim());
      content = extracted.content;
      sessionId = sessionId ?? extracted.sessionId;
    }
  }

  if (!content) {
    console.error("No content provided. Use --content or pipe via stdin.");
    process.exit(1);
  }

  try {
    const event = await logEvent({
      role: role as any,
      eventType: eventType as any,
      content,
      contentType: contentType as any,
      sessionId,
      dataDir: resolveTilde(values.data as string),
    });

    console.log(JSON.stringify({ event_id: event.id, sequence: event.sequence }));
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
