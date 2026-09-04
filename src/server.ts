/**
 * Facthouse MCP Server
 *
 * AI memory engine exposed as an MCP server.
 * Structured knowledge with server-side intelligence. Any AI tool can query it via MCP.
 */

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import {
  CLI_NAME,
  DEFAULT_MCP_SERVER_NAME,
  envValue,
} from "./identity.js";
import { dataDirFromEnvOrDefault, resolveUserPath } from "./paths.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDatabase, type Db } from "./db/connection.js";
import { openStore } from "./db/store.js";
import { applySchema } from "./db/schema.js";
import { ensureSelfEntity } from "./db/entities.js";
import { loadStoreVocabulary } from "./db/domains.js";
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
import { startNotifyListener, type NotifyListener } from "./ipc/scheduler-ipc.js";
import { createCopyHeartbeat } from "./sources/copy.js";

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    data: {
      type: "string",
      default: dataDirFromEnvOrDefault(),
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
let ipcListener: NotifyListener | null = null;

// Idempotent shutdown path — may be invoked by MCP transport close, SIGINT,
// or SIGTERM. Guards against double-run so concurrent signals don't race.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ipcListener?.close();
  if (scheduler && triggers.has("shutdown")) {
    await scheduler.run("shutdown").catch(() => undefined);
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
  // Also here, not only in `facthouse init` — init is optional, and a store the
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
      name: DEFAULT_MCP_SERVER_NAME,
      version: pkg.version,
    },
    {
      capabilities: { resources: { subscribe: true, listChanged: true } },
      // Tools-only clients never fetch memory://briefing. This is the session-start
      // result that tells them to call get_session_context instead — same briefing.
      instructions: SESSION_BOOTSTRAP_INSTRUCTIONS,
    },
  );

  const clientSessionId = envValue("CLIENT_SESSION") ?? null;

  const sessionManager = createSessionManager(database, clientSessionId);
  sessionManager.registerTools(server);

  // A store that has just switched to bi-temporal mode gets `bitemporal_since`
  // stamped here — historical supersessions cannot be backfilled.
  const config = ensureBitemporalSince(dataDir, loadedConfig);
  const triggerSet = new Set(config.consolidation.triggers);
  triggers = triggerSet;

  // Provider selector — heuristic is always the terminal fallback. Defaults to
  // the CLI provider: subprocess `claude -p` for real LLM consolidation
  // via the user's own subscription. The FACTHOUSE_PROVIDER env var overrides
  // the config.json choice (kill-switch, e.g. FACTHOUSE_PROVIDER=heuristic).
  const storeVocabulary = await loadStoreVocabulary(
    database,
    config.domains ?? [],
  );
  const heuristic = createHeuristicProvider(storeVocabulary);
  const intelligence = createIntelligenceProvider(config.intelligence, {
    vocabulary: storeVocabulary,
    server: server.server,
    heuristic,
  });

  // Semantic search, if this store has opted in. Null is the shipped default and
  // means keyword-only retrieval — nothing is downloaded and nothing is called.
  // Built once at boot: resolution reads config and the environment, neither of
  // which changes mid-process.
  const embeddingProvider = createEmbeddingProvider(config.embedding, {
    onUnavailable: (reason) => console.error(`[facthouse] ${reason}`),
  });

  // Named sources: copy new lines when a tool or resource is read if the
  // files grew. Empty sources never walks a client home. Does not extract.
  const heartbeat = createCopyHeartbeat({
    db: database,
    sources: config.sources,
    onCopied: (copied) => {
      console.error(
        `[facthouse] Copied ${copied.events_inserted} line(s) from ${copied.files} source file(s).`,
      );
    },
    onError: (err) => {
      console.error(`[facthouse] Source copy failed: ${err.message}`);
    },
  });
  const beforeRead = async () => {
    try {
      await heartbeat.copyIfGrown();
    } catch {
      // copyIfGrown already swallows; a throwing hook must not fail search.
    }
  };

  // Resources are automatically-loaded context (memory://briefing, memory://profile).
  // Registered before connect(), because registering one registers the resources
  // capability and capabilities are frozen once the transport attaches.
  const resources = registerResources(server, database, beforeRead);

  const factManager = createFactManager(database, sessionManager, {
    intelligence,
    embedding: embeddingProvider,
    serverConfig: {
      extraction: config.extraction,
      temporal: config.temporal,
      intelligence: config.intelligence,
    },
    // Both of these shipped in the default config and never reached the code that
    // reads them, so the hardcoded defaults always won whatever a store set.
    captureConfig: config.capture,
    autoLinkEvents: config.consolidation.auto_link_events,
    sources: config.sources,
    beforeRead,
    // The copy step of consolidate is this same heartbeat.
    copy: () => heartbeat.copyIfGrown({ force: true }),
    // Consolidation is the only thing that changes integrated knowledge, so it's
    // the only thing that can change what these resources render.
    onConsolidated: () => resources.notifyUpdated(),
  });
  registerSessionReadTools(server, sessionManager, database, beforeRead);
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
    config.interlocutor,
    beforeRead,
  );

  const sched = startScheduler({
    db: database,
    runConsolidate: (steps) =>
      factManager.runConsolidate(steps, {
        trigger: "scheduler",
        project: envValue("PROJECT") ?? null,
      }),
    threshold: config.consolidation.threshold,
  });
  scheduler = sched;

  const transport = new StdioServerTransport();

  // Start session when the MCP handshake completes.
  server.server.oninitialized = async () => {
    const clientInfo = server.server.getClientVersion();
    sessionManager.startSession(
      clientInfo?.name ?? null,
      envValue("PROJECT") ?? null,
    );

    // Listener for moments another process reports (threshold, compaction).
    // The moment → steps policy is MOMENT_POLICY; the listener only relays.
    if (triggerSet.has("threshold") || triggerSet.has("compaction")) {
      try {
        // A delivered moment is an explicit request from another process
        // (a hook, `facthouse notify`); `triggers` decides whether this server
        // listens at all, not whether it honours what it was told.
        ipcListener = await startNotifyListener(dataDir, (moment) => {
          void sched.run(moment);
        });
        if (!ipcListener.bound) {
          console.error(
            "[facthouse] Another MCP server is handling notifications for this data dir.",
          );
        }
      } catch (err) {
        console.error(
          `[facthouse] Could not start IPC listener: ${(err as Error).message}. ` +
            `Threshold / compaction triggers will not fire.`,
        );
      }
    }

    // session_start: copy, extract (capped), integrate. The copy step is the
    // same heartbeat every tool read uses, so a first get_session_context
    // cannot race a second walk of the same file. A large first backfill is
    // not extracted on the lot: the cap bounds the run and the remainder is
    // reported once.
    if (triggerSet.has("session_start")) {
      void sched.run("session_start").then((result) => {
        // Only the cap earns this line: a skipped or degraded run has its own
        // reason, and pointing at --all there would spawn the model on the lot.
        if (
          result &&
          !result.skipped &&
          !result.extractionDegraded &&
          result.eventsRemaining > 0
        ) {
          console.error(
            `[facthouse] ${result.eventsRemaining} line(s) still waiting to be extracted ` +
              `after this run's cap. Run ${CLI_NAME} consolidate --all, or let the ` +
              `next session start take the next batch.`,
          );
        }
      });
    } else {
      // No session_start trigger: still keep D current for the first read.
      await heartbeat.copyIfGrown();
    }
  };

  // The MCP SDK calls onclose synchronously and doesn't await our handler.
  // Run the shutdown sequence explicitly and exit only after it completes —
  // otherwise Node may exit before the shutdown-trigger integrate finishes
  // its LLM calls and DB writes.
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
