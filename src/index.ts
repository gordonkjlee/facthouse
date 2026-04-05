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

const sessionManager = createSessionManager(db);
sessionManager.registerTools(server);
registerSessionReadTools(server, sessionManager, db);

// Future tools will be registered here with withEventLogging wrapper.
// See docs/design/mcp-tools.md for the full specification.

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();

  // Start session when the MCP handshake completes.
  server.server.oninitialized = () => {
    const clientInfo = server.server.getClientVersion();
    sessionManager.startSession(
      clientInfo?.name ?? null,
      process.env.OPENMEMORY_PROJECT ?? null,
    );
  };

  // Clean up on connection close.
  server.server.onclose = () => {
    closeDatabase(db);
  };

  await server.connect(transport);
}

// Graceful shutdown.
process.on("SIGINT", () => {
  closeDatabase(db);
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  closeDatabase(db);
  process.exit(1);
});
