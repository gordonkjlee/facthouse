/**
 * Data-directory defaults and tilde expansion.
 *
 * One function for the default store path and one expander for user-typed
 * paths. The CLI, MCP server, and init snippet names must not each invent
 * `path.join(homedir(), ".openmemory")`.
 */

import { homedir } from "node:os";
import path from "node:path";

/** Directory name under the home folder for the default store. */
export const DEFAULT_DATA_DIRNAME = ".openmemory";

/** Absolute default data directory (`~/.openmemory`). */
export function defaultDataDir(): string {
  return path.join(homedir(), DEFAULT_DATA_DIRNAME);
}

/** Expand a leading `~` without resolving against the local cwd. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Expand `~` and resolve to an absolute path. */
export function resolveUserPath(p: string): string {
  return path.resolve(expandTilde(p));
}
