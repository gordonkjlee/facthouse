#!/usr/bin/env node

/**
 * OpenMemory CLI entry point.
 * Subcommands: log-event
 */

import { parseArgs } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { logEvent, extractContentFromHookPayload } from "./log-event.js";

const DEFAULT_DATA_DIR = path.join(homedir(), ".openmemory");

function resolveTilde(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);

    // Don't hang if stdin is a TTY with no data.
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

async function main() {
  const subcommand = process.argv[2];

  if (subcommand === "log-event") {
    await runLogEvent();
  } else {
    console.error(
      `Usage: openmemory <command>\n\nCommands:\n  log-event   Log a session event (used by hooks)`,
    );
    process.exit(1);
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
    const event = logEvent({
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
