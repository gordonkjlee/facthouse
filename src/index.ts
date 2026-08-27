#!/usr/bin/env node

/**
 * OpenMemory MCP Server
 *
 * AI memory engine exposed as an MCP server.
 * Structured knowledge with server-side intelligence. Any AI tool can query it via MCP.
 */

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { defaultDataDir, resolveUserPath } from "./paths.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDatabase, type Db } from "./db/connection.js";
import { openStore } from "./db/store.js";
import { applySchema } from "./db/schema.js";
import { ensureSelfEntity } from "./db/entities.js";
import { createEmbeddingProvider } from "./embedding/provider.js";
import { createSessionManager, registerSessionReadTools } from "./tools/session-manager.js";
import { createFactManager } from "./tools/fact-manager.js";
import { createHeuristicProvider } from "./intelligence/heuristic.js";
import { createIntelligenceProvider } from "./intelligence/provider.js";
import { registerReadTools } from "./tools/read-tools.js";
import { registerInferenceTools } from "./tools/inferences.js";
import { registerResources, SESSION_BOOTSTRAP_INSTRUCTIONS } from "./tools/resources.js";
import { startScheduler, type Scheduler } from "./scheduler.js";
import { loadShippedStoreConfig, ensureBitemporalSince } from "./config.js";
import { startSchedulerListener, type SchedulerListener } from "./ipc/scheduler-ipc.js";
import { pullSources, shouldFlushAfterSessionStartPull } from "./sources/pull.js";

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    data: {
      type: "string",
      default: process.env.OPENMEMORY_DATA ?? defaultDataDir(),
    },
  },
  strict: false, // Allow unknown flags (MCP clients may pass extras).
});

const dataDir = resolveUserPath(values.data as string);
mkdirSync(dataDir, { recursive: true });

// Storage check before opening an engine. Unknown providers and postgres
// without a URL must not create memory.db. Print the message and exit rather
// than dumping a stack into the MCP stdio stream.
let loadedConfig: ReturnType<typeof loadShippedStoreConfig>;
try {
  loadedConfig = loadShippedStoreConfig(dataDir);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let db: Db | undefined;
let scheduler: Scheduler | undefined;
let triggers = new Set<string>();
let ipcListener: SchedulerListener | null = null;

// Idempotent shutdown path — may be invoked by MCP transport close, SIGINT,
// or SIGTERM. Guards against double-run so concurrent signals don't race.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ipcListener?.close();
  if (scheduler && triggers.has("shutdown")) {
    await scheduler.flush().catch(() => undefined);
  }
  if (db) await closeDatabase(db);
}

async function main() {
  // ---------------------------------------------------------------------------
  // Database
  // ---------------------------------------------------------------------------

  let database: Db;
  try {
    database = await openStore(dataDir, loadedConfig);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }
  db = database;
  await applySchema(database);
  // Also here, not only in `openmemory init` — init is optional, and a store the
  // server created on first boot needs the anchor just as much as one that was
  // set up ahead of time. Idempotent.
  await ensureSelfEntity(database);

  // ---------------------------------------------------------------------------
  // MCP Server
  // ---------------------------------------------------------------------------

  // `subscribe` must be declared here: registering a resource auto-registers
  // `resources: { listChanged: true }`, but not subscribe, and capabilities are
  // frozen once a transport is attached. Without it, clients can't ask to be told
  // when the briefing changes.
  const server = new McpServer(
    {
      name: "openmemory",
      version: pkg.version,
    },
    {
      capabilities: { resources: { subscribe: true, listChanged: true } },
      // Tools-only clients never fetch memory://briefing. This is the session-start
      // result that tells them to call get_session_context instead — same briefing.
      instructions: SESSION_BOOTSTRAP_INSTRUCTIONS,
    },
  );

  const clientSessionId = process.env.OPENMEMORY_CLIENT_SESSION ?? null;

  const sessionManager = createSessionManager(database, clientSessionId);
  sessionManager.registerTools(server);
  registerSessionReadTools(server, sessionManager, database);

  // A store that has just switched to bi-temporal mode gets `bitemporal_since`
  // stamped here — historical supersessions cannot be backfilled.
  const config = ensureBitemporalSince(dataDir, loadedConfig);
  const triggerSet = new Set(config.consolidation.triggers);
  triggers = triggerSet;

  // Provider selector — heuristic is always the terminal fallback. Defaults to
  // the CLI provider: subprocess `claude -p` for real LLM consolidation
  // via the user's own subscription. The OPENMEMORY_PROVIDER env var overrides
  // the config.json choice (kill-switch, e.g. OPENMEMORY_PROVIDER=heuristic).
  const heuristic = createHeuristicProvider();
  const intelligence = createIntelligenceProvider(config.intelligence, {
    vocabulary: config.domains ?? [],
    server: server.server,
    heuristic,
  });

  // Semantic search, if this store has opted in. Null is the shipped default and
  // means keyword-only retrieval — nothing is downloaded and nothing is called.
  // Built once at boot: resolution reads config and the environment, neither of
  // which changes mid-process.
  const embeddingProvider = createEmbeddingProvider(config.embedding, {
    onUnavailable: (reason) => console.error(`[openmemory] ${reason}`),
  });

  // Resources are automatically-loaded context (memory://briefing, memory://profile).
  // Registered before connect(), because registering one registers the resources
  // capability and capabilities are frozen once the transport attaches.
  const resources = registerResources(server, database);

  const factManager = createFactManager(database, sessionManager, {
    intelligence,
    embedding: embeddingProvider,
    serverConfig: { extraction: config.extraction, temporal: config.temporal },
    // Both of these shipped in the default config and never reached the code that
    // reads them, so the hardcoded defaults always won whatever a store set.
    captureConfig: config.capture,
    autoLinkEvents: config.consolidation.auto_link_events,
    sources: config.sources,
    // Consolidation is the only thing that changes graduated knowledge, so it's
    // the only thing that can change what these resources render.
    onConsolidated: () => resources.notifyUpdated(),
  });
  factManager.registerTools(server);
  if (config.inferences.enabled) {
    registerInferenceTools(server, database, {
      onConfirmed: () => resources.notifyUpdated(),
    });
  }
  registerReadTools(
    server,
    database,
    embeddingProvider,
    {
      minSimilarityRatio: config.embedding?.min_similarity_ratio,
      minSimilarity: config.embedding?.min_similarity ?? undefined,
      ann: config.embedding?.ann,
      annMaxBytes: config.embedding?.ann_max_bytes,
    },
    config.temporal,
  );

  const sched = startScheduler({
    db: database,
    runConsolidate: (phase) => factManager.runConsolidate(phase),
    threshold: config.consolidation.threshold,
  });
  scheduler = sched;

  const transport = new StdioServerTransport();

  // Start session when the MCP handshake completes.
  server.server.oninitialized = async () => {
    const clientInfo = server.server.getClientVersion();
    sessionManager.startSession(
      clientInfo?.name ?? null,
      process.env.OPENMEMORY_PROJECT ?? null,
    );

    // IPC listener for threshold + compaction signals.
    if (triggerSet.has("threshold") || triggerSet.has("compaction")) {
      try {
        ipcListener = await startSchedulerListener(dataDir, (kind) => {
          if (kind === "flush") void sched.flush();
          else void sched.tick();
        });
        if (!ipcListener.bound) {
          console.error(
            "[openmemory] Another MCP server is handling scheduler signals for this data dir.",
          );
        }
      } catch (err) {
        console.error(
          `[openmemory] Could not start IPC listener: ${(err as Error).message}. ` +
            `Threshold / compaction triggers will not fire.`,
        );
      }
    }

    // Pull named sources before session_start full() so a small incremental
    // ingest can extract then graduate in the same pass. Empty sources is a
    // no-op. Errors are logged rather than fatal — a bad source must not take
    // down log_event.
    let eventsInserted = 0;
    try {
      const pulled = await pullSources(database, config.sources);
      eventsInserted = pulled.events_inserted;
      if (pulled.events_inserted > 0) {
        console.error(
          `[openmemory] Pulled ${pulled.events_inserted} event(s) from ${pulled.files} source file(s).`,
        );
      }
    } catch (err) {
      console.error(`[openmemory] Source pull failed: ${(err as Error).message}`);
    }

    // session_start: leftovers when nothing new was pulled, or a handful of
    // new lines. Full pipeline (extract then graduate). A large first-backfill
    // must not spawn that here. PreCompact flush is graduate-only.
    if (triggerSet.has("session_start")) {
      if (shouldFlushAfterSessionStartPull(eventsInserted)) {
        void sched.full();
      } else {
        console.error(
          `[openmemory] Pulled ${eventsInserted} event(s) — skipping session_start ` +
            `consolidation so a first-run backfill does not spawn claude -p on the lot. ` +
            `Run openmemory consolidate when ready, or wait for a later incremental pull.`,
        );
      }
    }
  };

  // The MCP SDK calls onclose synchronously and doesn't await our handler.
  // Run the shutdown sequence explicitly and exit only after it completes —
  // otherwise Node may exit before the shutdown-trigger flush finishes its
  // LLM calls and DB writes.
  server.server.onclose = () => {
    void shutdown().then(() => process.exit(0));
  };

  await server.connect(transport);
}

// Graceful shutdown — same path for SIGINT and SIGTERM.
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

main().catch(async (error) => {
  console.error("Fatal error:", error);
  if (db) await closeDatabase(db).catch(() => undefined);
  process.exit(1);
});
