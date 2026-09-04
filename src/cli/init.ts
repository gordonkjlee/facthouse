/**
 * init CLI command — prepares a data directory for use.
 *
 * The server creates its data dir and schema on first boot anyway, so init is
 * not required to run Facthouse. What init adds is:
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
import { closeDatabase, type Dialect } from "../db/connection.js";
import { applySchema, getSchemaVersion } from "../db/schema.js";
import { openStore, sqliteMemoryPath } from "../db/store.js";
import { ensureDomain } from "../db/domains.js";
import { ensureSelfEntity } from "../db/entities.js";
import {
  CONFIG_FILENAME,
  defaultServerConfig,
  loadShippedStoreConfig,
} from "../config.js";
import { probeCliProvider, type CliProbeResult } from "../intelligence/cli.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import {
  DEFAULT_MODEL as OLLAMA_DEFAULT_MODEL,
  ollamaHost,
  probeOllama,
} from "../embedding/ollama.js";
import { resolveSources } from "../sources/resolve.js";
import type { IntelligenceProviderType, EmbeddingConfig } from "../types/config.js";
import {
  DEFAULT_MCP_SERVER_NAME,
  envName,
} from "../identity.js";
import { defaultDataDir } from "../paths.js";
import {
  INIT_PROMPTS,
  applyInitOverlay,
  type InitOverlay,
} from "./init-knobs.js";

/**
 * Render a copy-pasteable MCP client config block.
 *
 * Built via JSON.stringify rather than string interpolation: a Windows data dir
 * contains backslashes, which must be escaped to produce valid JSON. Emitting
 * the path raw yields a snippet that fails to parse when pasted.
 *
 * @param spec     npm package spec, e.g. "@facthouse/mcp@0.3.0"
 * @param dataDir  when set, adds a FACTHOUSE_DATA env override (omit for the
 *                 default location, which needs no env entry)
 * @param indent   spaces to prefix each line with, for console output
 * @param name     MCP server key. A second store needs a second name —
 *                 two entries both called `facthouse` overwrite each other.
 */
export function mcpConfigSnippet(
  spec: string,
  dataDir?: string,
  indent = 2,
  name = DEFAULT_MCP_SERVER_NAME,
): string {
  const entry: Record<string, unknown> = { command: "npx", args: ["-y", spec] };
  if (dataDir) entry.env = { [envName("DATA")]: dataDir };
  const pad = " ".repeat(indent);
  return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)
    .split("\n")
    .map((l) => `${pad}${l}`)
    .join("\n");
}

export { DEFAULT_MCP_SERVER_NAME };

/**
 * MCP server key for a data directory. The default store is `facthouse`.
 * Any other directory gets a derived name so two snippets can share one
 * mcp.json. A non-default folder whose basename is `facthouse` is
 * `facthouse-store` so it cannot paste over the default key.
 */
export function mcpServerName(
  dataDir: string,
  defaultDir: string = defaultDataDir(),
): string {
  const resolved = path.resolve(dataDir);
  if (resolved === path.resolve(defaultDir)) return DEFAULT_MCP_SERVER_NAME;

  const base = path.basename(resolved).replace(/^\.+/, "");
  const sanitized =
    base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()
    || "store";

  if (sanitized === DEFAULT_MCP_SERVER_NAME) {
    return `${DEFAULT_MCP_SERVER_NAME}-store`;
  }
  if (sanitized.startsWith(`${DEFAULT_MCP_SERVER_NAME}-`)) return sanitized;
  return `${DEFAULT_MCP_SERVER_NAME}-${sanitized}`;
}

/**
 * Env is omitted only for the default directory, never because the name
 * equals "facthouse".
 */
export function mcpSnippetDataDir(
  dataDir: string,
  defaultDir: string = defaultDataDir(),
): string | undefined {
  return path.resolve(dataDir) === path.resolve(defaultDir) ? undefined : dataDir;
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
      `working. Set ${envName("PROVIDER")}=heuristic to turn the subprocess off.`,
    ];
  }

  return [
    `WARNING: the claude CLI was not found, so consolidation falls back to the`,
    `built-in heuristic. It stores facts, but extracts no entities and does`,
    `no domain routing — your knowledge graph will be flat.`,
    ``,
    `  To fix:  install the Claude Code CLI, or set intelligence.cli.command in`,
    `           config.json, or point CLAUDE_CLI_PATH at the binary.`,
    `  To keep: set ${envName("PROVIDER")}=heuristic and this notice goes away.`,
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
export async function embeddingStatusLines(
  config: EmbeddingConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  probe: typeof probeOllama = probeOllama,
): Promise<string[]> {
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

  if (config?.provider === "ollama") {
    const probed = await probe(ollamaHost(config.host));
    const model = config.model ?? OLLAMA_DEFAULT_MODEL;
    const modelPresent = probed.models.some(
      (n) => n === model || n.startsWith(`${model}:`),
    );
    if (!probed.ok) {
      return [
        `WARNING: Ollama at ${probed.host} did not answer GET /api/tags (liveness only — this is not an embed).`,
        `Semantic search is off until it is running. embedding.provider is still "ollama" in config.json.`,
      ];
    }
    if (!modelPresent) {
      return [
        `WARNING: Ollama at ${probed.host} is running, but ${model} is not in GET /api/tags.`,
        `Semantic search is off until you run: ollama pull ${model}`,
        `embedding.provider is still "ollama" in config.json.`,
      ];
    }
  }

  return [
    `Semantic search: on, via ${config?.provider} (${provider.model}). Facts are`,
    `embedded at consolidation, so an existing store fills in on the next run.`,
  ];
}

export function appendCaptureRecipe(
  sources: unknown,
  opts: {
    captureAskedAndEmpty?: boolean;
    captureSkippedCwd?: boolean;
    dataDir?: string;
    /** First-run done card: next command only, no mix/record warnings. */
    brief?: boolean;
  } = {},
): string[] {
  if (opts.captureSkippedCwd) {
    return [INIT_PROMPTS.cwdSkipped];
  }
  if (opts.captureAskedAndEmpty) {
    return [INIT_PROMPTS.captureDeclined];
  }
  const status = sourcesStatusLines(sources, opts.dataDir, opts.brief);
  if (opts.brief) return status;
  try {
    if (resolveSources(sources).length > 0) {
      return [...status, INIT_PROMPTS.mixCopyRecord];
    }
  } catch {
    return status;
  }
  return status;
}

/**
 * Report whether this store will copy Claude Code transcripts.
 *
 * Empty `sources` is the shipped default and means copy is off. Init writes
 * that empty list so the knob is visible. Facts still get in via
 * `capture_fact` until a source is named — that is the sentence a silent
 * `--yes` run must print, or it reads like copy is required.
 */
export function sourcesStatusLines(
  sources: unknown,
  dataDir?: string,
  brief?: boolean,
): string[] {
  let n: number;
  try {
    n = resolveSources(sources).length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`Capture: config.sources is invalid — ${message}`];
  }
  if (n === 0) {
    return [
      `Capture: copy is off. capture_fact is how facts get in.`,
      `Transcripts: ${INIT_PROMPTS.copyRecipe}`,
    ];
  }
  const next = `Capture: ${n} source${n === 1 ? "" : "s"}. ${INIT_PROMPTS.copyNext(dataDir)}`;
  if (brief) return [next];
  return [next, INIT_PROMPTS.copyStorewide];
}

export interface InitArgs {
  /** Absolute path to the data directory (tilde already resolved). */
  dataDir: string;
  /** Overwrite an existing config.json with defaults. Default false. */
  force?: boolean;
  /** Narrow overlay applied when writing config.json. Preserve ignores it. */
  overlay?: InitOverlay;
  /** Process environment. Tests pass a clean object so a developer's store env cannot leak. */
  env?: NodeJS.ProcessEnv;
}

export interface InitResult {
  dataDir: string;
  dbPath: string;
  configPath: string;
  /** sqlite or postgres. Postgres does not create `memory.db`. */
  dialect: Dialect;
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
  const { dataDir, force = false, overlay, env = process.env } = args;

  // Refuse an unknown engine or postgres without a URL *before* mkdir/open —
  // otherwise a postgres config still creates memory.db and we have failed open.
  const effective = loadShippedStoreConfig(dataDir, env);

  const createdDataDir = !existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true });

  // Resolve the vocabulary to seed from the effective config — an existing
  // config.json (a user may have added their own domains) or the shipped
  // defaults. Read before the config is written so a first run seeds exactly
  // what it is about to write.
  const seedDomains = effective.domains ?? [];

  // Create/migrate the database. applySchema is idempotent and versioned.
  // Postgres: tables live at FACTHOUSE_POSTGRES_URL; memory.db is not created.
  const dbPath = sqliteMemoryPath(dataDir);
  const db = await openStore(dataDir, effective, env);
  let schemaVersion: number;
  try {
    await applySchema(db);
    schemaVersion = await getSchemaVersion(db);
    // Seed the domain vocabulary the config declares. The table previously
    // started empty and stayed empty until the first fact integrated, so the
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
    const toWrite = applyInitOverlay(defaultServerConfig(), overlay ?? {});
    writeFileSync(
      configPath,
      JSON.stringify(toWrite, null, 2) + "\n",
      "utf-8",
    );
  }

  return {
    dataDir,
    dbPath,
    configPath,
    dialect: db.dialect,
    createdDataDir,
    wroteConfig,
    configPreserved: configExisted && !force,
    schemaVersion,
  };
}
