/**
 * Data-directory defaults and tilde expansion.
 *
 * One function for the default store path and one expander for user-typed
 * paths. The CLI, MCP server, and init snippet names must not each invent
 * `path.join(homedir(), ".facthouse")`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_FILENAME } from "./config.js";
import { DEFAULT_DATA_DIRNAME, envValue } from "./identity.js";

export { DEFAULT_DATA_DIRNAME };

export interface DefaultDataDirOpts {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Walk-up from here. CLI sets this; MCP does not walk. */
  cwd?: string;
  exists?: (p: string) => boolean;
  walkUp?: boolean;
}

/** Absolute path of the default (`~/.facthouse`). */
export function newInstallDataDir(home: string = homedir()): string {
  return path.join(home, DEFAULT_DATA_DIRNAME);
}

/**
 * Nearest `.facthouse` with `config.json`, walking up from `cwd`.
 * Also matches when `cwd` itself is that store directory.
 */
export function findNearestFacthouseStore(
  cwd: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    if (
      path.basename(dir) === DEFAULT_DATA_DIRNAME &&
      exists(path.join(dir, CONFIG_FILENAME))
    ) {
      return dir;
    }
    const nested = path.join(dir, DEFAULT_DATA_DIRNAME);
    if (exists(path.join(nested, CONFIG_FILENAME))) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Default store directory when the user did not pass `--data` / a positional.
 *
 * Order: FACTHOUSE_DATA, else (if `walkUp`) nearest `.facthouse`, else
 * `~/.facthouse`. Does not look at `.factmem` or `.openmemory`. Never copies
 * or moves a directory. MCP must not set `walkUp` — a project store must not
 * hijack a home-store server that has no FACTHOUSE_DATA.
 */
export function defaultDataDir(opts: DefaultDataDirOpts = {}): string {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const fromEnv = envValue("DATA", env);
  if (fromEnv) return path.resolve(expandTilde(fromEnv));
  if (opts.walkUp) {
    const found = findNearestFacthouseStore(
      opts.cwd ?? process.cwd(),
      opts.exists ?? existsSync,
    );
    if (found) return found;
  }
  return path.join(home, DEFAULT_DATA_DIRNAME);
}

/** MCP / shared: env override or home default. No walk-up. */
export function dataDirFromEnvOrDefault(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envValue("DATA", env) ?? defaultDataDir({ env });
}

/** One help/README line for the CLI `--data` default. */
export const CLI_STORE_DEFAULT_HELP =
  "FACTHOUSE_DATA, a .facthouse store in this project, or ~/.facthouse";

/** CLI `--data` default: env, else nearest `.facthouse`, else home. */
export function cliStoreDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  exists?: (p: string) => boolean,
): string {
  return defaultDataDir({ env, cwd, walkUp: true, exists });
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
