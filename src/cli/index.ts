#!/usr/bin/env node

/**
 * OpenMemory CLI entry point.
 * Subcommands: log-event, consolidate
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { logEvent, extractContentFromHookPayload } from "./log-event.js";
import {
  initDataDir,
  mcpConfigSnippet,
  providerStatusLines,
  embeddingStatusLines,
} from "./init.js";
import { runSearch, formatSearch, formatStats, formatPrune, getStats } from "./query.js";
import { prunableEvents, pruneEvents, vacuum } from "../db/prune.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { applySchema } from "../db/schema.js";
import { consolidate } from "../intelligence/consolidate.js";
import { createHeuristicProvider } from "../intelligence/heuristic.js";
import { createIntelligenceProvider, resolveProviderType } from "../intelligence/provider.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import type { IntelligenceProvider } from "../intelligence/types.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import { DEFAULT_CONFIG, type ServerConfig } from "../types/config.js";
import { loadConfig } from "../config.js";
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
  const subcommand = process.argv[2];

  // Recursion guard: any subprocess-based intelligence provider that
  // re-invokes an MCP client should set OPENMEMORY_SUBPROCESS=1 in the
  // child's env. If a surviving hook then re-enters this CLI, we must not
  // log events, signal the scheduler, or consolidate — each would feed back
  // into an extraction loop. Exit silently with success.
  //
  // `init` is exempt: it only creates a directory, database, and config, so it
  // cannot recurse. Skipping it here would make an explicit setup command exit
  // 0 having silently done nothing — a confusing failure with no diagnostic.
  if (process.env.OPENMEMORY_SUBPROCESS === "1" && subcommand !== "init") {
    process.exit(0);
  }

  if (subcommand === "init") {
    await runInit();
  } else if (subcommand === "log-event") {
    await runLogEvent();
  } else if (subcommand === "consolidate") {
    await runConsolidate();
  } else if (subcommand === "signal") {
    await runSignal();
  } else if (subcommand === "search") {
    await runSearchCmd();
  } else if (subcommand === "stats") {
    await runStatsCmd();
  } else if (subcommand === "prune") {
    await runPruneCmd();
  } else {
    console.error(
      `Usage: openmemory <command>\n\n` +
        `Commands:\n` +
        `  init [dir]    Create the data directory, database, and default config\n` +
        `  search <q>    Search the knowledge base\n` +
        `  stats         Show knowledge base statistics\n` +
        `  prune         Reclaim raw events nothing can reach (dry run by default)\n` +
        `  log-event     Log a session event (used by hooks)\n` +
        `  signal        Signal the running MCP server to tick or flush\n` +
        `  consolidate   Run consolidation in-process with the configured provider`,
    );
    process.exit(1);
  }
}

/** Package version, for the copy-pasteable MCP snippet. Best-effort. */
function packageVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function runInit() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string" },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  // Accept `openmemory init ~/.openmemory` (positional) as well as --data, so
  // the documented form and the flag used by every other subcommand both work.
  const target =
    positionals[0] ??
    (values.data as string | undefined) ??
    process.env.OPENMEMORY_DATA ??
    DEFAULT_DATA_DIR;
  // Normalise to an absolute, platform-native path so every path we print (and
  // embed in the MCP snippet) is consistent regardless of how it was typed.
  const dataDir = path.resolve(resolveTilde(target));

  let result;
  try {
    result = initDataDir({ dataDir, force: values.force as boolean });
  } catch (err: any) {
    console.error(`Failed to initialise ${dataDir}: ${err.message}`);
    process.exit(1);
  }

  const version = packageVersion();
  const spec = version ? `@openmem/mcp@${version}` : "@openmem/mcp";

  // Only non-default locations need an OPENMEMORY_DATA override.
  const isDefaultDir = dataDir === path.resolve(DEFAULT_DATA_DIR);
  const snippet = mcpConfigSnippet(spec, isDefaultDir ? undefined : result.dataDir);

  const lines = [
    ``,
    `OpenMemory initialised.`,
    ``,
    `  Data directory  ${result.dataDir}${result.createdDataDir ? " (created)" : ""}`,
    `  Database        ${result.dbPath} (schema v${result.schemaVersion})`,
    `  Config          ${result.configPath}${
      result.wroteConfig ? " (written)" : " (already exists — left unchanged; use --force to reset)"
    }`,
    ``,
    `Add to your AI tool's MCP configuration:`,
    ``,
    snippet,
    ``,
    // Report the provider this store will really get, rather than describing
    // the default and leaving the user to discover which branch they landed on.
    ...providerStatusLines(
      resolveProviderType(loadConfig(result.dataDir).intelligence.provider),
    ),
    ``,
    ...embeddingStatusLines(loadConfig(result.dataDir).embedding),
    ``,
  ];
  console.log(lines.join("\n"));
}

/**
 * Async twin of `withDb`, for commands that await inside the connection.
 *
 * Separate rather than making `withDb` async: `stats` and the other read
 * commands are pure index reads and should not become promise-returning just
 * because search embeds its query.
 */
async function withDbAsync<T>(
  dataDir: string,
  fn: (db: ReturnType<typeof openDatabase>) => Promise<T>,
): Promise<T> {
  if (!existsSync(path.join(dataDir, "memory.db"))) {
    console.error(
      `No database at ${dataDir}. Run 'openmemory init ${dataDir}' first, ` +
        `or point at another directory with --data.`,
    );
    process.exit(1);
  }
  const db = openDatabase(path.join(dataDir, "memory.db"));
  try {
    applySchema(db);
    return await fn(db);
  } finally {
    closeDatabase(db);
  }
}

/**
 * Open the database read-only-ish for an inspection command, run `fn`, close.
 * Exits with a clear message when the data dir was never initialised, rather
 * than surfacing a raw SQLite error.
 */
function withDb<T>(dataDir: string, fn: (db: ReturnType<typeof openDatabase>) => T): T {
  if (!existsSync(path.join(dataDir, "memory.db"))) {
    console.error(
      `No database at ${dataDir}. Run 'openmemory init ${dataDir}' first, ` +
        `or point at another directory with --data.`,
    );
    process.exit(1);
  }
  const db = openDatabase(path.join(dataDir, "memory.db"));
  try {
    applySchema(db);
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

async function runSearchCmd() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? DEFAULT_DATA_DIR },
      domain: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const query = positionals.join(" ").trim();
  if (!query) {
    console.error(
      `Usage: openmemory search <query> [--domain <d>] [--limit <n>] [--json]`,
    );
    process.exit(1);
  }

  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    console.error(`Invalid --limit: ${values.limit}. Expected a positive number.`);
    process.exit(1);
  }

  const dataDir = path.resolve(resolveTilde(values.data as string));
  // Semantic recall if this store configured it. Reported when configured but
  // unusable, rather than silently searching keyword-only — from the command
  // line there is a person to tell.
  const config = loadConfig(dataDir);
  const embedding = createEmbeddingProvider(config.embedding, {
    onUnavailable: (reason) => console.error(`[openmemory] ${reason}`),
  });
  const response = await withDbAsync(dataDir, (db) =>
    runSearch(
      db,
      { query, domain: values.domain as string | undefined, limit },
      embedding,
      {
        minSimilarityRatio: config.embedding?.min_similarity_ratio,
        minSimilarity: config.embedding?.min_similarity ?? undefined,
      },
    ),
  );

  console.log(
    values.json ? JSON.stringify(response, null, 2) : formatSearch(response, query),
  );
}

async function runStatsCmd() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? DEFAULT_DATA_DIR },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const dataDir = path.resolve(resolveTilde(values.data as string));
  const stats = withDb(dataDir, (db) => getStats(db));

  console.log(values.json ? JSON.stringify(stats, null, 2) : formatStats(stats));
}

/**
 * Reclaim raw events that nothing can reach.
 *
 * Reports by default and deletes only when asked. Pruning is irreversible and
 * this is a memory product: the difference between "here is what would go" and
 * "it has gone" must be a deliberate keystroke, not a default.
 */
async function runPruneCmd() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? DEFAULT_DATA_DIR },
      apply: { type: "boolean", default: false },
      vacuum: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const dataDir = path.resolve(resolveTilde(values.data as string));
  const config = loadConfig(dataDir);
  // Defers to the setting it protects rather than repeating its default, unless
  // a store has deliberately overridden it.
  const keep =
    config.retention?.prune_keep_per_session ?? config.extraction?.working_memory_size ?? 50;
  const apply = values.apply as boolean;

  const result = withDb(dataDir, (db) => {
    const stats = apply ? pruneEvents(db, keep) : prunableEvents(db, keep);
    // Only after a successful delete — vacuuming a database nothing was removed
    // from is a long rewrite for no reason.
    if (apply && (values.vacuum as boolean) && stats.events > 0) vacuum(db);
    return stats;
  });

  if (values.json) {
    console.log(JSON.stringify({ ...result, applied: apply }, null, 2));
    return;
  }
  console.log(formatPrune(result, apply, keep, values.vacuum as boolean));
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
  //
  // The fallback deliberately uses the heuristic provider (not the configured
  // one): the point of a PreCompact flush is that data survives the context
  // collapse quickly. Spawning `claude -p` for cli-quality here could take
  // ~35-50s during a time-critical compaction. Lower quality, but fast and
  // dependency-free — heuristic-era facts can be reprocessed later.
  if (kind === "flush") {
    console.error(
      "[openmemory] Server unreachable; running heuristic consolidate in-process as fallback.",
    );
    await consolidateInProcess(dataDir, createHeuristicProvider(), DEFAULT_CONFIG);
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

  // Manual `openmemory consolidate` honours the configured provider (default
  // cli — real LLM quality). There's no MCP server here, so a `sampling`
  // selection degrades to heuristic; `cli` spawns `claude -p` directly. The
  // OPENMEMORY_SUBPROCESS guard at the top of main() prevents recursion when
  // this runs inside a provider subprocess.
  const config = loadConfig(dataDir);
  const provider = createIntelligenceProvider(config.intelligence, {
    vocabulary: config.domains ?? [],
  });
  // Embeddings are written here too, not only by the server. `openmemory
  // consolidate` is the documented way to process a store by hand, and a store
  // consolidated that way would otherwise never gain a vector.
  const embedding = createEmbeddingProvider(config.embedding, {
    onUnavailable: (reason) => console.error(`[openmemory] ${reason}`),
  });
  await consolidateInProcess(dataDir, provider, config, embedding);
}

/**
 * Open the DB at dataDir, run consolidate() with the given provider, print the
 * JSON result, then close. Used by both `openmemory consolidate` (configured
 * provider) and the `signal flush` fallback (heuristic, for fast survival).
 *
 * Taking dataDir + provider as parameters (rather than re-parsing process.argv
 * or hardcoding a provider) lets callers invoke this from contexts where argv
 * contains positional args the parser doesn't expect (e.g. signal flush's own
 * `flush` positional) and choose the provider appropriate to the context.
 */
export async function consolidateInProcess(
  dataDir: string,
  provider: IntelligenceProvider,
  config: Partial<ServerConfig> = DEFAULT_CONFIG,
  embedding: EmbeddingProvider | null = null,
): Promise<void> {
  const dbPath = path.join(dataDir, "memory.db");
  const db = openDatabase(dbPath);

  try {
    applySchema(db);
    const result = await consolidate(db, provider, config, embedding);
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
