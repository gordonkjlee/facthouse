/**
 * Product identifiers. One definition — CLI, MCP snippets, env, data dir,
 * README tests, and publish smoke import from here. Do not copy these strings
 * into a second file.
 *
 * Compat aliases (OpenMemory / OPENMEMORY_* / @openmem/mcp / `.openmemory`)
 * are still read so existing stores, hooks, and mcp.json keep working. New
 * snippets and logs emit only the FactMem names.
 */

export const PRODUCT_NAME = "FactMem";
export const PRODUCT_SLUG = "factmem";
export const CLI_NAME = "factmem";
export const CLI_NAME_COMPAT = "openmemory";
export const NPM_PACKAGE = "@factmem/mcp";
export const NPM_PACKAGE_COMPAT = "@openmem/mcp";
export const DEFAULT_MCP_SERVER_NAME = "factmem";
export const GITHUB_REPO = "gordonkjlee/openmemory";
export const DEFAULT_DATA_DIRNAME = ".factmem";
export const DEFAULT_DATA_DIRNAME_COMPAT = ".openmemory";
export const ENV_PREFIX = "FACTMEM";
export const ENV_PREFIX_COMPAT = "OPENMEMORY";
export const LOG_PREFIX = "[factmem]";
export const INSPECT_TITLE = "FactMem inspect";
export const BRIEFING_HEADING = "# FactMem Briefing";
export const WINDOWS_PIPE_PREFIX = "openmemory";

export function envName(suffix: string, prefix: string = ENV_PREFIX): string {
  return `${prefix}_${suffix}`;
}

/** New prefix wins when both are set. Empty / whitespace is unset. */
export function envValue(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const neu = env[envName(suffix)]?.trim();
  if (neu) return neu;
  const old = env[envName(suffix, ENV_PREFIX_COMPAT)]?.trim();
  if (old) return old;
  return undefined;
}

export function envIsSet(
  suffix: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envValue(suffix, env) === value;
}

/** npm spec for MCP snippets, e.g. `@factmem/mcp@0.23.0`. */
export function npmPackageSpec(version: string | null | undefined): string {
  return version ? `${NPM_PACKAGE}@${version}` : NPM_PACKAGE;
}

/** Env keys that select a store. Tests must strip both prefixes. */
export const STORE_ENV_KEYS: readonly string[] = [
  envName("DATA"),
  envName("DATA", ENV_PREFIX_COMPAT),
  envName("SUBPROCESS"),
  envName("SUBPROCESS", ENV_PREFIX_COMPAT),
  envName("STORAGE"),
  envName("STORAGE", ENV_PREFIX_COMPAT),
  envName("POSTGRES_URL"),
  envName("POSTGRES_URL", ENV_PREFIX_COMPAT),
];

/** Set on the intelligence CLI child so both argv0s refuse to recurse. */
export function subprocessGuardEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    [envName("SUBPROCESS")]: "1",
    [envName("SUBPROCESS", ENV_PREFIX_COMPAT)]: "1",
  };
}
