/**
 * Server configuration loader.
 *
 * Reads <dataDir>/config.json if present and deep-merges it over DEFAULT_CONFIG.
 * Missing file → defaults silently. Malformed JSON → defaults with a stderr
 * warning (non-fatal — we'd rather run with sane defaults than fail to boot).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { envName, envValue } from "./identity.js";
import { DEFAULT_CONFIG, type ServerConfig } from "./types/config.js";

/** Filename expected in the data dir. */
export const CONFIG_FILENAME = "config.json";

/**
 * Deep-merge overrides onto a base object. Overrides win for scalar/array
 * fields; nested objects merge recursively. Arrays are replaced, not merged,
 * because our config arrays (triggers, event_types, roles) are user-authoritative
 * selections — a user-supplied array means "these exact entries, nothing else".
 */
export function mergeConfig<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : (override as T);
  }
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    out[key] = mergeConfig((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/**
 * The complete default configuration — every knob the server understands, with
 * its shipped default. `loadConfig` merges the user's config.json over this,
 * and `factmem init` writes it out verbatim so the knobs are discoverable
 * (otherwise defaults are invisible and users can't find what's tunable).
 */
export function defaultServerConfig(): ServerConfig {
  return {
    storage: { provider: "sqlite" },
    temporal: { mode: "simple", bitemporal_since: null },
    ...DEFAULT_CONFIG,
    // The core taxonomy ships in config rather than staying buried in code, so
    // it is visible and editable: a user can add their own domains here and they
    // exist from first run. Seeding also gives a classifier something to be
    // consistent with — schema-congruence needs a schema to pre-exist, and an
    // empty vocabulary offers nothing to match against.
    // No domains. The engine ships no categories and no rules: it cannot know
    // whether this store is about a life, a company or a research programme, and
    // every vocabulary it could offer would be wrong for someone.
    //
    // Declare your own here to give the fallback classifier something to route
    // on and to calibrate importance — each domain takes a description, regex
    // `patterns`, and an `importance`. With an LLM provider (the default) you do
    // not need to: it classifies from the content, and the routing prompt names
    // whatever domains already exist so the vocabulary grows from use and stays
    // consistent with itself.
    domains: [],
  };
}

/**
 * Default transactional engine. sqlite is zero-config; postgres is opt-in.
 * A request for anything else is refused — it must not silently open SQLite.
 */
export const SHIPPED_STORAGE_PROVIDER = "sqlite";

/** Engines this package will actually open. Unknown values still die. */
export const SUPPORTED_STORAGE_PROVIDERS = ["sqlite", "postgres"] as const;
export type StorageProvider = (typeof SUPPORTED_STORAGE_PROVIDERS)[number];

/** Environment variable holding the Postgres URL. Canonical name; compat still read. */
export const POSTGRES_URL_ENV = envName("POSTGRES_URL");

/**
 * Which engine the store asked for. `FACTMEM_STORAGE` (or `OPENMEMORY_STORAGE`)
 * wins over `storage.provider`. Missing or empty is sqlite.
 */
export function configuredStorageProvider(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = envValue("STORAGE", env);
  if (fromEnv) return fromEnv.toLowerCase();
  const storage = (config as { storage?: unknown }).storage;
  if (typeof storage === "string" && storage.trim() !== "") {
    return storage.trim().toLowerCase();
  }
  if (storage !== null && typeof storage === "object" && !Array.isArray(storage)) {
    const provider = (storage as { provider?: unknown }).provider;
    if (typeof provider === "string" && provider.trim() !== "") {
      return provider.trim().toLowerCase();
    }
  }
  return SHIPPED_STORAGE_PROVIDER;
}

export function isSupportedStorage(provider: string): provider is StorageProvider {
  return (SUPPORTED_STORAGE_PROVIDERS as readonly string[]).includes(provider);
}

/** Unknown engine. Callers must not open SQLite after this. */
export function unsupportedStorageMessage(provider: string): string {
  return (
    `Unknown storage provider "${provider}". The default engine is sqlite; ` +
    `postgres is optional. SQLite was not opened.`
  );
}

export function assertSupportedStorage(
  provider: string,
): asserts provider is StorageProvider {
  if (isSupportedStorage(provider)) return;
  throw new Error(unsupportedStorageMessage(provider));
}

export function postgresUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue("POSTGRES_URL", env);
}

export function postgresMissingUrlMessage(): string {
  return (
    `Storage provider is postgres but ${POSTGRES_URL_ENV} is not set. ` +
    `SQLite was not opened. Set the URL on the MCP entry (the same place as ` +
    `${envName("DATA")}) or in the environment.`
  );
}

export function postgresInvalidUrlMessage(): string {
  return (
    `${POSTGRES_URL_ENV} must be a postgres:// or postgresql:// URL. ` +
    `SQLite was not opened.`
  );
}

export function postgresConnectFailedMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Could not connect to Postgres (${detail}). SQLite was not opened.`;
}

function isPostgresConnectionString(url: string): boolean {
  return /^(?:postgres|postgresql):\/\//i.test(url);
}

/**
 * Required URL when the engine is postgres. Empty and the wrong scheme both
 * die here — callers must not open SQLite afterwards.
 */
export function postgresUrlOrThrow(env: NodeJS.ProcessEnv = process.env): string {
  const url = postgresUrl(env);
  if (!url) throw new Error(postgresMissingUrlMessage());
  if (!isPostgresConnectionString(url)) throw new Error(postgresInvalidUrlMessage());
  return url;
}

/**
 * Load config and refuse an unknown engine *before* a database file is
 * created. Postgres is allowed; a missing URL is refused here so init does
 * not prompt and then fail, and so MCP boot prints a clean message rather
 * than a stack.
 */
export function loadShippedStoreConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const config = loadConfig(dataDir);
  const provider = configuredStorageProvider(config, env);
  assertSupportedStorage(provider);
  if (provider === "postgres") postgresUrlOrThrow(env);
  return config;
}

/** Load server config. Always returns a valid ServerConfig. */
export type ConfigDocumentErrorCode = "missing" | "malformed" | "not-object";

/** Fail-closed reader for a settings-style writer. Does not swallow. */
export class ConfigDocumentError extends Error {
  readonly code: ConfigDocumentErrorCode;
  constructor(code: ConfigDocumentErrorCode, message: string) {
    super(message);
    this.name = "ConfigDocumentError";
    this.code = code;
  }
}

/**
 * Raw on-disk `config.json`. Throws on missing, malformed, or non-object.
 * Does not merge defaults. Does not mkdir. Must not be used as MCP boot.
 */
export function readConfigDocument(dataDir: string): Record<string, unknown> {
  const configPath = path.join(dataDir, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigDocumentError(
        "missing",
        `No ${CONFIG_FILENAME} at ${configPath}`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigDocumentError(
      "malformed",
      `${CONFIG_FILENAME} is malformed`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigDocumentError(
      "not-object",
      `${CONFIG_FILENAME} must be a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Pretty-print `config.json`. The file must already exist. Caller decides
 * whether the serialised text changed.
 */
export function writeConfigDocument(
  dataDir: string,
  doc: Record<string, unknown>,
): void {
  const configPath = path.join(dataDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    throw new ConfigDocumentError(
      "missing",
      `No ${CONFIG_FILENAME} at ${configPath}`,
    );
  }
  writeFileSync(configPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

export function loadConfig(dataDir: string): ServerConfig {
  const base = defaultServerConfig();

  const configPath = path.join(dataDir, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    // Missing file is the common case — return defaults silently.
    return base;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[factmem] Ignoring malformed ${CONFIG_FILENAME}: ${(err as Error).message}. Using defaults.`,
    );
    return base;
  }

  return mergeConfig(base, honourLegacyConfigKeys(parsed));
}

/**
 * Read-time compatibility for renamed keys. `intelligence.cli.graduate_model`
 * became `integrate_model` when the pipeline vocabulary settled on copy /
 * extract / integrate; a store written by an earlier release keeps working
 * and is told once per process. `factmem settings` rewrites the key.
 */
export function honourLegacyConfigKeys(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const doc = parsed as { intelligence?: { cli?: Record<string, unknown> } };
  const cli = doc.intelligence?.cli;
  if (!cli || typeof cli !== "object") return parsed;
  if (cli.integrate_model === undefined && typeof cli.graduate_model === "string") {
    cli.integrate_model = cli.graduate_model;
    if (!legacyKeyNoticeShown) {
      legacyKeyNoticeShown = true;
      console.error(
        `[factmem] ${CONFIG_FILENAME}: intelligence.cli.graduate_model is now ` +
          `integrate_model. Still honoured; run factmem settings to rewrite it.`,
      );
    }
  }
  return parsed;
}
let legacyKeyNoticeShown = false;

/**
 * Warning on an as-of-system-time read whose instant precedes the switch to
 * bi-temporal recording. One string, used by the MCP tool and the CLI so they
 * cannot disagree about what "incomplete" means.
 */
export const SYSTEM_TIME_INCOMPLETE_WARNING =
  "Results may be incomplete: this store started recording when the system " +
  "retracted a belief after the requested instant, and earlier supersessions " +
  "did not stamp it.";

/** Warning text when T precedes `bitemporal_since`, or the stamp is missing. */
export function systemTimeWarning(at: string, since: string | null): string | null {
  if (!since || at < since) return SYSTEM_TIME_INCOMPLETE_WARNING;
  return null;
}

/**
 * When a store has just switched to bi-temporal mode, record `bitemporal_since`
 * so as-of-system-time reads can warn about the unstamped era.
 *
 * Historical supersessions cannot be backfilled — simple mode never wrote
 * `system_retired_at`. The stamp is the earliest instant at which that column
 * is trustworthy. Idempotent: a store that already has a stamp is left alone.
 */
export function ensureBitemporalSince(
  dataDir: string,
  config: ServerConfig,
): ServerConfig {
  if (config.temporal.mode !== "bitemporal") return config;
  if (config.temporal.bitemporal_since) return config;

  const since = new Date().toISOString();
  persistBitemporalSince(dataDir, since);
  return {
    ...config,
    temporal: { ...config.temporal, bitemporal_since: since },
  };
}

function persistBitemporalSince(dataDir: string, since: string): void {
  const configPath = path.join(dataDir, CONFIG_FILENAME);
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable — write a stub so the stamp survives a restart.
    // loadConfig merges, so a temporal-only file still yields full defaults.
  }

  const existing =
    parsed.temporal !== null &&
    typeof parsed.temporal === "object" &&
    !Array.isArray(parsed.temporal)
      ? { ...(parsed.temporal as Record<string, unknown>) }
      : {};
  if (typeof existing.bitemporal_since === "string" && existing.bitemporal_since) {
    return;
  }
  existing.bitemporal_since = since;
  parsed.temporal = existing;
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
}
