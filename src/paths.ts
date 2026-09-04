/**
 * Data-directory defaults and tilde expansion.
 *
 * One function for the default store path and one expander for user-typed
 * paths. The CLI, MCP server, and init snippet names must not each invent
 * `path.join(homedir(), ".facthouse")`.
 */

import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_DATA_DIRNAME, envValue } from "./identity.js";

export { DEFAULT_DATA_DIRNAME };

export interface DefaultDataDirOpts {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Absolute path of the default (`~/.facthouse`). */
export function newInstallDataDir(home: string = homedir()): string {
  return path.join(home, DEFAULT_DATA_DIRNAME);
}

/**
 * Default store directory when the user did not pass `--data` / a positional.
 *
 * Order: FACTHOUSE_DATA, else `~/.facthouse`. Does not look at `.factmem` or
 * `.openmemory`. Never copies or moves a directory.
 */
export function defaultDataDir(opts: DefaultDataDirOpts = {}): string {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const fromEnv = envValue("DATA", env);
  if (fromEnv) return path.resolve(expandTilde(fromEnv));
  return path.join(home, DEFAULT_DATA_DIRNAME);
}

/** `--data` flag default: env override or {@link defaultDataDir}. */
export function dataDirFromEnvOrDefault(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envValue("DATA", env) ?? defaultDataDir({ env });
}

/** Expand a leading `~` without resolving against the local cwd. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

/** Expand `~` and resolve to an absolute path. */
export function resolveUserPath(p: string): string {
  return path.resolve(expandTilde(p));
}

/**
 * Typed init answers must look like a filesystem path, not a sentence.
 * Empty means the caller should keep the default.
 */
export function looksLikeUserPath(raw: string): boolean {
  const t = raw.trim();
  if (t === "") return true;
  if (/^[A-Za-z]:([\\/]|$)/.test(t)) return true;
  if (
    t.startsWith("~") ||
    t.startsWith(".") ||
    t.startsWith("/") ||
    t.startsWith("\\")
  ) {
    return true;
  }
  return t.includes("/") || t.includes("\\");
}

/** Path-shaped, or a single segment that already exists after resolve. */
export function acceptTypedPath(
  raw: string,
  exists: (absPath: string) => boolean,
): boolean {
  const t = raw.trim();
  if (looksLikeUserPath(t)) return true;
  return exists(resolveUserPath(t));
}
