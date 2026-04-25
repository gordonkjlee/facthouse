/**
 * Server configuration loader.
 *
 * Reads <dataDir>/config.json if present and deep-merges it over DEFAULT_CONFIG.
 * Missing file → defaults silently. Malformed JSON → defaults with a stderr
 * warning (non-fatal — we'd rather run with sane defaults than fail to boot).
 */

import { readFileSync } from "node:fs";
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

/** Load server config. Always returns a valid ServerConfig. */
export function loadConfig(dataDir: string): ServerConfig {
  const base = {
    storage: { provider: "sqlite" as const },
    temporal: { mode: "simple" as const, bitemporal_since: null },
    ...DEFAULT_CONFIG,
  } satisfies ServerConfig;

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
