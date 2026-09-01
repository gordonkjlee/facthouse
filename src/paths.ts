/**
 * Data-directory defaults and tilde expansion.
 *
 * One function for the default store path and one expander for user-typed
 * paths. The CLI, MCP server, and init snippet names must not each invent
 * `path.join(homedir(), ".factmem")`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_DATA_DIRNAME,
  DEFAULT_DATA_DIRNAME_COMPAT,
  envValue,
} from "./identity.js";

export { DEFAULT_DATA_DIRNAME, DEFAULT_DATA_DIRNAME_COMPAT };

export interface DefaultDataDirOpts {
  home?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

/** Absolute path of the new default (`~/.factmem`), ignoring an old store. */
export function newInstallDataDir(home: string = homedir()): string {
  return path.join(home, DEFAULT_DATA_DIRNAME);
}

/**
 * Default store directory when the user did not pass `--data` / a positional.
 *
 * Order: FACTMEM_DATA, OPENMEMORY_DATA, existing `~/.factmem`, existing
 * `~/.openmemory`, else `~/.factmem`. Never copies or moves a directory.
 */
export function defaultDataDir(opts: DefaultDataDirOpts = {}): string {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const fromEnv = envValue("DATA", env);
  if (fromEnv) return path.resolve(expandTilde(fromEnv));
  const neu = path.join(home, DEFAULT_DATA_DIRNAME);
  const old = path.join(home, DEFAULT_DATA_DIRNAME_COMPAT);
  if (exists(neu)) return neu;
  if (exists(old)) return old;
  return neu;
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
