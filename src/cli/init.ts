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
import { ensureSelfEntity } from "../db/entities.js";
import {
  CONFIG_FILENAME,
  defaultServerConfig,
  loadShippedStoreConfig,
} from "../config.js";
import { probeCliProvider, type CliProbeResult } from "../intelligence/cli.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import { resolveSources } from "../sources/resolve.js";
import type { IntelligenceProviderType, EmbeddingConfig } from "../types/config.js";

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
 * @param name     MCP server key. A second brain needs a second name —
 *                 two entries both called `openmemory` overwrite each other.
 */
export function mcpConfigSnippet(
  spec: string,
  dataDir?: string,
  indent = 2,
  name = "openmemory",
): string {
  const entry: Record<string, unknown> = { command: "npx", args: ["-y", spec] };
  if (dataDir) entry.env = { OPENMEMORY_DATA: dataDir };
  const pad = " ".repeat(indent);
  return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)
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

/**
 * Report what semantic search this store will get.
 *
 * Same reasoning as `providerStatusLines`: the difference between "deliberately
 * keyword-only" and "configured but not working" is invisible from the outside,
 * and a store that thinks it has semantic search and does not will simply
 * return fewer results for ever without saying why.
 *
 * Off is a first-class answer here, not a warning. Keyword-only is the shipped
 * default and a legitimate choice — the failure worth shouting about is the
 * configured-but-unusable one.
 */
export function embeddingStatusLines(
  config: EmbeddingConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const reasons: string[] = [];
  const provider = createEmbeddingProvider(config, {
    env,
    onUnavailable: (r) => reasons.push(r),
  });

  if (reasons.length > 0) {
    return [
      `WARNING: ${reasons[0]}.`,
      `Semantic search is off; search will match words rather than meanings.`,
      `Set the variable, or set embedding.provider to null in config.json to`,
      `choose keyword-only deliberately.`,
    ];
  }

  if (!provider) {
    return [
      `Semantic search: off. Search matches words, not meanings — "shellfish"`,
      `finds a shellfish fact, "food" does not. Set embedding.provider in`,
      `config.json to "ollama" (local, no API key) or "voyage" (hosted) to`,
      `turn it on.`,
    ];
  }

  return [
    `Semantic search: on, via ${config?.provider} (${provider.model}). Facts are`,
    `embedded at consolidation, so an existing store fills in on the next run.`,
  ];
}

/**
 * Report whether this store will pull Claude Code transcripts.
 *
 * Empty `sources` is the shipped default and means pull is off. Init writes
 * that empty list so the knob is visible; this is the sentence that says
 * what to do with it, otherwise a tester initialises a store, never names a
 * source, and wonders why `search` is empty.
 */
export function sourcesStatusLines(sources: unknown): string[] {
  let n: number;
  try {
    n = resolveSources(sources).length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`Capture: config.sources is invalid — ${message}`];
  }
  if (n === 0) {
    return [
      `Capture: pull is off (sources is empty). Add a claude-code or cursor source to`,
      `config.json — kind, home (e.g. ~/.claude or ~/.cursor), cwd (e.g. C:\\dev\\app).`,
      `Set cwd. Then run openmemory pull. A first pull of more than 50 events`,
      `needs openmemory consolidate; a later session start will flush a smaller leftover.`,
    ];
  }
  return [
    `Capture: ${n} source${n === 1 ? "" : "s"}. Run openmemory pull.`,
    `A first pull of more than 50 events needs openmemory consolidate.`,
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
 */
export async function initDataDir(args: InitArgs): Promise<InitResult> {
  const { dataDir, force = false } = args;

  // Refuse a non-sqlite engine *before* mkdir/open — otherwise a postgres
  // config still creates memory.db and we have failed open.
  const effective = loadShippedStoreConfig(dataDir);

  const createdDataDir = !existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true });

  // Resolve the vocabulary to seed from the effective config — an existing
  // config.json (a user may have added their own domains) or the shipped
  // defaults. Read before the config is written so a first run seeds exactly
  // what it is about to write.
  const seedDomains = effective.domains ?? [];

  // Create/migrate the database. applySchema is idempotent and versioned.
  const dbPath = path.join(dataDir, "memory.db");
  const db = openDatabase(dbPath);
  let schemaVersion: number;
  try {
    await applySchema(db);
    schemaVersion = await pragmaRead(db, "user_version");
    // Seed the domain vocabulary the config declares. The table previously
    // started empty and stayed empty until the first fact graduated, so the
    // earliest facts had no existing vocabulary to be routed against — the
    // point at which consistent routing matters most. ensureDomain is
    // idempotent, so re-running init is safe.
    for (const domain of seedDomains) {
      await ensureDomain(db, domain.name, domain.subdomains);
    }
    // The user's own entity, nameless until a fact says otherwise. Created here
    // rather than on first use so that the very first fact captured can already
    // be marked as being about them — there is no window in which facts arrive
    // with nowhere to anchor. Idempotent, so re-running init is safe.
    await ensureSelfEntity(db);
  } finally {
    await closeDatabase(db);
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
