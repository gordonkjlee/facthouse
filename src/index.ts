#!/usr/bin/env node

/**
 * OpenMemory MCP Server
 *
 * AI memory engine exposed as an MCP server.
 * Structured knowledge with server-side intelligence. Any AI tool can query it via MCP.
 */

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase, closeDatabase } from "./db/connection.js";
import { applySchema } from "./db/schema.js";
import { createSessionManager, registerSessionReadTools } from "./tools/session-manager.js";
import { createFactManager } from "./tools/fact-manager.js";
import { createSamplingProvider } from "./intelligence/sampling.js";
import { createHeuristicProvider } from "./intelligence/heuristic.js";
import { registerReadTools } from "./tools/read-tools.js";
import { startScheduler, type Scheduler } from "./scheduler.js";
import { loadConfig } from "./config.js";
import { startSchedulerListener, type SchedulerListener } from "./ipc/scheduler-ipc.js";

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = path.join(homedir(), ".openmemory");

const { values } = parseArgs({
  options: {
    data: {
      type: "string",
      default: process.env.OPENMEMORY_DATA ?? DEFAULT_DATA_DIR,
    },
  },
  strict: false, // Allow unknown flags (MCP clients may pass extras).
});

const rawDataDir = values.data as string;
const dataDir = rawDataDir.startsWith("~/")
  ? path.join(homedir(), rawDataDir.slice(2))
  : rawDataDir === "~"
    ? homedir()
    : rawDataDir;
mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const dbPath = path.join(dataDir, "memory.db");
const db = openDatabase(dbPath);
applySchema(db);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

const server = new McpServer({
  name: "openmemory",
  version: pkg.version,
});

const clientSessionId = process.env.OPENMEMORY_CLIENT_SESSION ?? null;

const sessionManager = createSessionManager(db, clientSessionId);
sessionManager.registerTools(server);
registerSessionReadTools(server, sessionManager, db);

// Load config (reads <dataDir>/config.json if present, otherwise defaults).
const config = loadConfig(dataDir);
const triggers = new Set(config.consolidation.triggers);

// Provider selector — heuristic is always the fallback. The sampling provider
// uses the MCP client's sampling capability for LLM-quality consolidation;
// when the client doesn't advertise sampling, the provider falls through to
// heuristic per-method. Users can override the choice via config.json.
const heuristic = createHeuristicProvider();
const intelligence =
  config.intelligence.provider === "sampling"
    ? createSamplingProvider(server.server, heuristic)
    : heuristic;

const factManager = createFactManager(db, sessionManager, {
  intelligence,
  serverConfig: { extraction: config.extraction },
});
factManager.registerTools(server);
registerReadTools(server, db);

const scheduler: Scheduler = startScheduler({
  db,
  runConsolidate: () => factManager.runConsolidate(),
  threshold: config.consolidation.threshold,
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let ipcListener: SchedulerListener | null = null;

// Idempotent shutdown path — may be invoked by MCP transport close, SIGINT,
// or SIGTERM. Guards against double-run so concurrent signals don't race.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ipcListener?.close();
  if (triggers.has("shutdown")) {
    await scheduler.flush().catch(() => undefined);
  }
  closeDatabase(db);
}

async function main() {
  const transport = new StdioServerTransport();

  // Start session when the MCP handshake completes.
  server.server.oninitialized = async () => {
    const clientInfo = server.server.getClientVersion();
    sessionManager.startSession(
      clientInfo?.name ?? null,
      process.env.OPENMEMORY_PROJECT ?? null,
    );

    // IPC listener for threshold + compaction signals.
    if (triggers.has("threshold") || triggers.has("compaction")) {
      try {
        ipcListener = await startSchedulerListener(dataDir, (kind) => {
          if (kind === "flush") void scheduler.flush();
          else void scheduler.tick();
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

    // session_start: process any events left over from a prior session.
    if (triggers.has("session_start")) {
      void scheduler.flush();
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

main().catch((error) => {
  console.error("Fatal error:", error);
  closeDatabase(db);
  process.exit(1);
});
