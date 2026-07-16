/**
 * init CLI command — prepares a data directory for use.
 *
 * The server creates its data dir and schema on first boot anyway, so init is
 * not required to run OpenMemory. What init adds is:
 *   1. A config.json written from the shipped defaults. Without it the defaults
 *      are invisible — users have no way to discover what's tunable (which
 *      intelligence provider runs, consolidation triggers, retention, ...).
 *   2. Explicit, verifiable setup: the database and schema are created now,
 *      surfacing problems (e.g. a missing native SQLite binary) at install time
 *      rather than on the first tool call from an AI client.
 *
 * Idempotent: safe to re-run. An existing config.json is preserved unless
 * `force` is set, so re-running never silently discards a user's settings.
 * Schema migrations are applied on every run.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDatabase, closeDatabase, pragmaRead } from "../db/connection.js";
import { applySchema } from "../db/schema.js";
import { CONFIG_FILENAME, defaultServerConfig } from "../config.js";

/**
 * Render a copy-pasteable MCP client config block.
 *
 * Built via JSON.stringify rather than string interpolation: a Windows data dir
 * contains backslashes, which must be escaped to produce valid JSON. Emitting
 * the path raw yields a snippet that fails to parse when pasted.
 *
 * @param spec     npm package spec, e.g. "@openmem/mcp@0.3.0"
 * @param dataDir  when set, adds an OPENMEMORY_DATA env override (omit for the
 *                 default location, which needs no env entry)
 * @param indent   spaces to prefix each line with, for console output
 */
export function mcpConfigSnippet(
  spec: string,
  dataDir?: string,
  indent = 2,
): string {
  const entry: Record<string, unknown> = { command: "npx", args: ["-y", spec] };
  if (dataDir) entry.env = { OPENMEMORY_DATA: dataDir };
  const pad = " ".repeat(indent);
  return JSON.stringify({ mcpServers: { openmemory: entry } }, null, 2)
    .split("\n")
    .map((l) => `${pad}${l}`)
    .join("\n");
}

export interface InitArgs {
  /** Absolute path to the data directory (tilde already resolved). */
  dataDir: string;
  /** Overwrite an existing config.json with defaults. Default false. */
  force?: boolean;
}

export interface InitResult {
  dataDir: string;
  dbPath: string;
  configPath: string;
  /** The data directory did not exist and was created. */
  createdDataDir: boolean;
  /** config.json was written (false when it existed and force wasn't set). */
  wroteConfig: boolean;
  /** config.json already existed and was left untouched. */
  configPreserved: boolean;
  /** Schema version after migrations. */
  schemaVersion: number;
}

/**
 * Create (or update) a data directory: database + schema + default config.
 * Synchronous — mirrors the rest of the SQLite data layer.
 */
export function initDataDir(args: InitArgs): InitResult {
  const { dataDir, force = false } = args;

  const createdDataDir = !existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true });

  // Create/migrate the database. applySchema is idempotent and versioned.
  const dbPath = path.join(dataDir, "memory.db");
  const db = openDatabase(dbPath);
  let schemaVersion: number;
  try {
    applySchema(db);
    schemaVersion = pragmaRead(db, "user_version");
  } finally {
    closeDatabase(db);
  }

  // Write defaults only when absent (or forced) — never clobber user settings.
  const configPath = path.join(dataDir, CONFIG_FILENAME);
  const configExisted = existsSync(configPath);
  const wroteConfig = !configExisted || force;
  if (wroteConfig) {
    writeFileSync(
      configPath,
      JSON.stringify(defaultServerConfig(), null, 2) + "\n",
      "utf-8",
    );
  }

  return {
    dataDir,
    dbPath,
    configPath,
    createdDataDir,
    wroteConfig,
    configPreserved: configExisted && !force,
    schemaVersion,
  };
}
