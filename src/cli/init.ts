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
import { ensureDomain } from "../db/domains.js";
import { CONFIG_FILENAME, defaultServerConfig, loadConfig } from "../config.js";
import { probeCliProvider, type CliProbeResult } from "../intelligence/cli.js";
import type { IntelligenceProviderType } from "../types/config.js";

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

/**
 * Report what consolidation intelligence this store will actually get.
 *
 * The `cli` provider is the default, and when the CLI it shells out to is
 * missing every stage degrades to the heuristic provider. That provider stores
 * facts but extracts no entities and does no domain routing — deliberately, on
 * an engine that ships no vocabulary — so the server still boots, the tools
 * still answer, and the store quietly fills with flat facts. Nothing in the
 * product said which of the two you were getting.
 *
 * `init` is the right place to say it: it is the one moment the user is
 * watching setup output, and it is before any knowledge has been captured
 * against the wrong provider.
 *
 * @param provider the effective provider, after the env kill-switch is applied
 * @param probe    deferred so no subprocess runs unless `cli` is in play
 */
export function providerStatusLines(
  provider: IntelligenceProviderType,
  probe: () => CliProbeResult = () => probeCliProvider(),
): string[] {
  if (provider !== "cli") {
    return [
      `Consolidation intelligence: ${provider}. Change it via intelligence.provider`,
      `in config.json.`,
    ];
  }

  if (probe().available) {
    return [
      `Consolidation intelligence: the claude CLI (no API key needed) — found and`,
      `working. Set OPENMEMORY_PROVIDER=heuristic to turn the subprocess off.`,
    ];
  }

  return [
    `WARNING: the claude CLI was not found, so consolidation falls back to the`,
    `built-in heuristic. It stores facts, but extracts no entities and does`,
    `no domain routing — your knowledge graph will be flat.`,
    ``,
    `  To fix:  install the Claude Code CLI, or set intelligence.cli.command in`,
    `           config.json, or point CLAUDE_CLI_PATH at the binary.`,
    `  To keep: set OPENMEMORY_PROVIDER=heuristic and this notice goes away.`,
  ];
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

  // Resolve the vocabulary to seed from the effective config — an existing
  // config.json (a user may have added their own domains) or the shipped
  // defaults. Read before the config is written so a first run seeds exactly
  // what it is about to write.
  const seedDomains = loadConfig(dataDir).domains ?? [];

  // Create/migrate the database. applySchema is idempotent and versioned.
  const dbPath = path.join(dataDir, "memory.db");
  const db = openDatabase(dbPath);
  let schemaVersion: number;
  try {
    applySchema(db);
    schemaVersion = pragmaRead(db, "user_version");
    // Seed the domain vocabulary the config declares. The table previously
    // started empty and stayed empty until the first fact graduated, so the
    // earliest facts had no existing vocabulary to be routed against — the
    // point at which consistent routing matters most. ensureDomain is
    // idempotent, so re-running init is safe.
    for (const domain of seedDomains) {
      ensureDomain(db, domain.name, domain.subdomains);
    }
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
