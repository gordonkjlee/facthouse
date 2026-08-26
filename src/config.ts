/**
 * Server configuration loader.
 *
 * Reads <dataDir>/config.json if present and deep-merges it over DEFAULT_CONFIG.
 * Missing file → defaults silently. Malformed JSON → defaults with a stderr
 * warning (non-fatal — we'd rather run with sane defaults than fail to boot).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, type ServerConfig } from "./types/config.js";

/** Filename expected in the data dir. */
export const CONFIG_FILENAME = "config.json";

/**
 * Deep-merge overrides onto a base object. Overrides win for scalar/array
 * fields; nested objects merge recursively. Arrays are replaced, not merged,
 * because our config arrays (triggers, event_types, roles) are user-authoritative
 * selections — a user-supplied array means "these exact entries, nothing else".
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : (override as T);
  }
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/**
 * The complete default configuration — every knob the server understands, with
 * its shipped default. `loadConfig` merges the user's config.json over this,
 * and `openmemory init` writes it out verbatim so the knobs are discoverable
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

/** Load server config. Always returns a valid ServerConfig. */
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
      `[openmemory] Ignoring malformed ${CONFIG_FILENAME}: ${(err as Error).message}. Using defaults.`,
    );
    return base;
  }

  return deepMerge(base, parsed);
}

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
