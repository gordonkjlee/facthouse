#!/usr/bin/env node

/**
 * OpenMemory CLI entry point.
 * Subcommands: log-event, consolidate, pull
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { logEvent, extractContentFromHookPayload } from "./log-event.js";
import {
  initDataDir,
  mcpConfigSnippet,
  mcpServerName,
  mcpSnippetDataDir,
  providerStatusLines,
  embeddingStatusLines,
  sourcesStatusLines,
} from "./init.js";
import { defaultDataDir, resolveUserPath } from "../paths.js";
import { runSearch, formatSearch, formatStats, formatPrune, getStats } from "./query.js";
import { prunableEvents, pruneEvents, vacuum } from "../db/prune.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { applySchema } from "../db/schema.js";
import {
  consolidate,
  type ConsolidatePhase,
} from "../intelligence/consolidate.js";
import { createHeuristicProvider } from "../intelligence/heuristic.js";
import { createIntelligenceProvider, resolveProviderType } from "../intelligence/provider.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import type { IntelligenceProvider } from "../intelligence/types.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import { DEFAULT_CONFIG, type ServerConfig } from "../types/config.js";
import type { SessionEvent } from "../types/data.js";
import {
  loadConfig,
  loadShippedStoreConfig,
  ensureBitemporalSince,
  systemTimeWarning,
} from "../config.js";
import { parseSystemTime } from "../db/facts.js";
import { sendSchedulerSignal, type SignalKind } from "../ipc/scheduler-ipc.js";
import { pullSources, shouldTickAfterCliPull } from "../sources/pull.js";

const SESSION_ROLES = ["user", "assistant", "system", "tool"] as const;
const SESSION_EVENT_TYPES = ["message", "tool_call", "tool_result", "artifact"] as const;
const SESSION_CONTENT_TYPES = ["text", "json", "image", "audio", "binary"] as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSessionRole(value: string): value is SessionEvent["role"] {
  return (SESSION_ROLES as readonly string[]).includes(value);
}

function isSessionEventType(value: string): value is SessionEvent["event_type"] {
  return (SESSION_EVENT_TYPES as readonly string[]).includes(value);
}

function isSessionContentType(value: string): value is SessionEvent["content_type"] {
  return (SESSION_CONTENT_TYPES as readonly string[]).includes(value);
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
  } else if (subcommand === "pull") {
    await runPull();
  } else {
    console.error(
      `Usage: openmemory <command>\n\n` +
        `Commands:\n` +
        `  init [dir]    Create the data directory, database, and default config\n` +
        `  search <q>    Search the knowledge base\n` +
        `  stats         Show knowledge base statistics\n` +
        `  prune         Reclaim raw events nothing can reach (dry run by default)\n` +
        `  pull          Ingest new events from named capture sources\n` +
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
    defaultDataDir();
  // Normalise to an absolute, platform-native path so every path we print (and
  // embed in the MCP snippet) is consistent regardless of how it was typed.
  const dataDir = resolveUserPath(target);

  let result;
  try {
    result = await initDataDir({ dataDir, force: values.force as boolean });
  } catch (err: unknown) {
    console.error(`Failed to initialise ${dataDir}: ${errorMessage(err)}`);
    process.exit(1);
  }

  const version = packageVersion();
  const spec = version ? `@openmem/mcp@${version}` : "@openmem/mcp";

  const snippet = mcpConfigSnippet(
    spec,
    mcpSnippetDataDir(result.dataDir),
    2,
    mcpServerName(result.dataDir),
  );

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
    `One data directory is one memory. A second brain is a second directory`,
    `with a different MCP server name and a different OPENMEMORY_DATA — not a`,
    `tenant column inside this store.`,
    ``,
    // Report the provider this store will really get, rather than describing
    // the default and leaving the user to discover which branch they landed on.
    ...providerStatusLines(
      resolveProviderType(loadConfig(result.dataDir).intelligence.provider),
    ),
    ``,
    ...embeddingStatusLines(loadConfig(result.dataDir).embedding),
    ``,
    ...sourcesStatusLines(loadConfig(result.dataDir).sources),
    ``,
  ];
  console.log(lines.join("\n"));
}

/**
 * Open the database for a command, run `fn`, close.
 * Exits with a clear message when the data dir was never initialised, rather
 * than surfacing a raw SQLite error.
 */
async function withDb<T>(
  dataDir: string,
  fn: (db: ReturnType<typeof openDatabase>) => T | Promise<T>,
): Promise<T> {
  loadShippedStoreConfig(dataDir);
  if (!existsSync(path.join(dataDir, "memory.db"))) {
    console.error(
      `No database at ${dataDir}. Run 'openmemory init ${dataDir}' first, ` +
        `or point at another directory with --data.`,
    );
    process.exit(1);
  }
  const db = openDatabase(path.join(dataDir, "memory.db"));
  try {
    await applySchema(db);
    return await fn(db);
  } finally {
    await closeDatabase(db);
  }
}

/**
 * Async twin of `withDb`, for commands whose callback is already a Promise.
 */
async function withDbAsync<T>(
  dataDir: string,
  fn: (db: ReturnType<typeof openDatabase>) => Promise<T>,
): Promise<T> {
  return withDb(dataDir, fn);
}

async function runSearchCmd() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? defaultDataDir() },
      domain: { type: "string" },
      limit: { type: "string" },
      "as-of-system": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const query = positionals.join(" ").trim();
  if (!query) {
    console.error(
      `Usage: openmemory search <query> [--domain <d>] [--limit <n>] [--as-of-system <t>] [--json]`,
    );
    process.exit(1);
  }

  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    console.error(`Invalid --limit: ${values.limit}. Expected a positive number.`);
    process.exit(1);
  }

  const dataDir = resolveUserPath(values.data as string);
  const config = ensureBitemporalSince(dataDir, loadConfig(dataDir));
  const rawAsOf = values["as-of-system"] as string | undefined;
  if (rawAsOf && config.temporal.mode !== "bitemporal") {
    console.error(
      `as-of system time needs temporal.mode "bitemporal" in config.json. ` +
        `The default simple mode does not record when the system retracted a belief.`,
    );
    process.exit(1);
  }
  let asOfSystemTime: string | undefined;
  if (rawAsOf) {
    try {
      asOfSystemTime = parseSystemTime(rawAsOf);
    } catch (err: unknown) {
      console.error(errorMessage(err));
      process.exit(1);
    }
  }
  // Semantic recall if this store configured it. Reported when configured but
  // unusable, rather than silently searching keyword-only — from the command
  // line there is a person to tell.
  const embedding = createEmbeddingProvider(config.embedding, {
    onUnavailable: (reason) => console.error(`[openmemory] ${reason}`),
  });
  const response = await withDbAsync(dataDir, (db) =>
    runSearch(
      db,
      {
        query,
        domain: values.domain as string | undefined,
        limit,
        asOfSystemTime,
      },
      embedding,
      {
        minSimilarityRatio: config.embedding?.min_similarity_ratio,
        minSimilarity: config.embedding?.min_similarity ?? undefined,
      },
    ),
  );
  if (asOfSystemTime) {
    response.system_time_warning = systemTimeWarning(
      asOfSystemTime,
      config.temporal.bitemporal_since,
    );
  }

  console.log(
    values.json ? JSON.stringify(response, null, 2) : formatSearch(response, query),
  );
}

async function runStatsCmd() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? defaultDataDir() },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const dataDir = resolveUserPath(values.data as string);
  const stats = await withDb(dataDir, (db) => getStats(db));

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
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? defaultDataDir() },
      apply: { type: "boolean", default: false },
      vacuum: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const dataDir = resolveUserPath(values.data as string);
  const config = loadConfig(dataDir);
  // Defers to the setting it protects rather than repeating its default, unless
  // a store has deliberately overridden it.
  const keep =
    config.retention?.prune_keep_per_session ?? config.extraction?.working_memory_size ?? 50;
  const apply = values.apply as boolean;

  const result = await withDb(dataDir, async (db) => {
    const stats = apply ? await pruneEvents(db, keep) : await prunableEvents(db, keep);
    // Only after a successful delete — vacuuming a database nothing was removed
    // from is a long rewrite for no reason.
    if (apply && (values.vacuum as boolean) && stats.events > 0) await vacuum(db);
    return stats;
  });

  if (values.json) {
    console.log(JSON.stringify({ ...result, applied: apply }, null, 2));
    return;
  }
  console.log(formatPrune(result, apply, keep, values.vacuum as boolean));
}

/**
 * Primary entry for client-agnostic capture: read `config.sources` and tail
 * each named home into session_events. Empty sources is a successful no-op.
 * The MCP server runs this same function once at session start; do not add
 * a third path.
 */
async function runPull() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? defaultDataDir() },
    },
    strict: true,
  });

  const dataDir = resolveUserPath(values.data as string);
  const config = loadConfig(dataDir);

  try {
    const result = await withDb(dataDir, async (db) => await pullSources(db, config.sources));
    const provider = resolveProviderType(config.intelligence.provider);
    if (result.events_inserted > 0 && provider === "heuristic") {
      console.error(
        "[openmemory] intelligence.provider is heuristic — it does not extract " +
          "facts from transcripts. capture_fact still works. Use the claude CLI " +
          "(the default provider) and run openmemory consolidate.",
      );
    }
    if (shouldTickAfterCliPull(result.events_inserted)) {
      const delivered = await sendSchedulerSignal(dataDir, "tick");
      if (!delivered) {
        console.error(
          "[openmemory] No MCP server listening — run openmemory consolidate " +
            "to graduate these events.",
        );
      }
    } else if (result.events_inserted > 0) {
      console.error(
        `[openmemory] Pulled ${result.events_inserted} event(s) — skipping auto-consolidate ` +
          `so a first-run backfill does not spawn claude -p on the lot. ` +
          `Run openmemory consolidate when ready.`,
      );
    }
    console.log(JSON.stringify(result));
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(1);
  }
}

async function runSignal() {
  const kindArg = process.argv[3] ?? "tick";
  const { values } = parseArgs({
    args: process.argv.slice(4),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? defaultDataDir() },
    },
    strict: true,
  });

  if (kindArg !== "tick" && kindArg !== "flush") {
    console.error(`Invalid signal kind: ${kindArg}. Expected 'tick' or 'flush'.`);
    process.exit(1);
  }
  const kind = kindArg as SignalKind;
  const dataDir = resolveUserPath(values.data as string);

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
      "[openmemory] Server unreachable; running heuristic I→K in-process as fallback. " +
        "Extract already ran on pull/Stop, or events stay events. " +
        "Start the MCP server (cli provider) or run openmemory consolidate with the claude CLI.",
    );
    await consolidateInProcess(
      dataDir,
      createHeuristicProvider(),
      loadConfig(dataDir),
      null,
      "graduate",
    );
    return;
  }

  // 'tick' delivery failed — silent exit. Don't spawn fallback work.
  console.log(JSON.stringify({ delivered: false, kind }));
}

async function runConsolidate() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? defaultDataDir() },
    },
    strict: true,
  });
  const dataDir = resolveUserPath(values.data as string);

  // Manual `openmemory consolidate` honours the configured provider (default
  // cli — real LLM quality). There's no MCP server here, so a `sampling`
  // selection degrades to heuristic; `cli` spawns `claude -p` directly. The
  // OPENMEMORY_SUBPROCESS guard at the top of main() prevents recursion when
  // this runs inside a provider subprocess.
  const config = ensureBitemporalSince(dataDir, loadConfig(dataDir));
  if (resolveProviderType(config.intelligence.provider) === "heuristic") {
    console.error(
      "[openmemory] intelligence.provider is heuristic — it does not extract " +
        "facts from transcripts. capture_fact still works.",
    );
  }
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
  phase: ConsolidatePhase = "full",
): Promise<void> {
  loadShippedStoreConfig(dataDir);
  const dbPath = path.join(dataDir, "memory.db");
  const db = openDatabase(dbPath);

  try {
    await applySchema(db);
    const result = await consolidate(db, provider, config, embedding, phase);
    if (result.extractionDegraded) {
      console.error(
        "[openmemory] Extraction could not run — events were not examined and the watermark was held. A zero factsGraduated here is not a successful empty extract. Re-run openmemory consolidate when the CLI provider can run.",
      );
    }
    console.log(JSON.stringify(result));
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(1);
  } finally {
    await closeDatabase(db);
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
      speaker: { type: "string" },
      data: { type: "string", default: process.env.OPENMEMORY_DATA ?? defaultDataDir() },
    },
    strict: true,
  });

  const role = values.role as string;
  const eventType = values["event-type"] as string;
  const contentType = values["content-type"] as string;

  if (!isSessionRole(role)) {
    console.error(`Invalid --role: ${role}. Must be one of: ${SESSION_ROLES.join(", ")}`);
    process.exit(1);
  }

  if (!isSessionEventType(eventType)) {
    console.error(
      `Invalid --event-type: ${eventType}. Must be one of: ${SESSION_EVENT_TYPES.join(", ")}`,
    );
    process.exit(1);
  }

  if (!isSessionContentType(contentType)) {
    console.error(
      `Invalid --content-type: ${contentType}. Must be one of: ${SESSION_CONTENT_TYPES.join(", ")}`,
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
      role,
      eventType,
      content,
      contentType,
      sessionId,
      speaker: (values.speaker as string | undefined) ?? null,
      dataDir: resolveUserPath(values.data as string),
    });

    console.log(JSON.stringify({ event_id: event.id, sequence: event.sequence }));
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exit(1);
});
