/**
 * Product identifiers. One definition — CLI, MCP snippets, env, data dir,
 * README tests, and publish smoke import from here. Do not copy these strings
 * into a second file.
 *
 * Facthouse is a hard cut. Previous names (FactMem, OpenMemory) are not
 * read, not published, and not emitted. Existing stores stay where they
 * are until the operator moves them.
 */

export const PRODUCT_NAME = "Facthouse";
export const PRODUCT_SLUG = "facthouse";
export const CLI_NAME = "facthouse";
export const NPM_PACKAGE = "@facthouse/mcp";
export const DEFAULT_MCP_SERVER_NAME = "facthouse";
export const GITHUB_REPO = "gordonkjlee/facthouse";
export const DEFAULT_DATA_DIRNAME = ".facthouse";
export const ENV_PREFIX = "FACTHOUSE";
export const LOG_PREFIX = "[facthouse]";
export const INSPECT_TITLE = "Facthouse inspect";
export const BRIEFING_HEADING = "# Facthouse Briefing";
export const WINDOWS_PIPE_PREFIX = "facthouse";

export function envName(suffix: string, prefix: string = ENV_PREFIX): string {
  return `${prefix}_${suffix}`;
}

/** Empty / whitespace is unset. Only the Facthouse prefix is read. */
export function envValue(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[envName(suffix)]?.trim();
  if (value) return value;
  return undefined;
}

export function envIsSet(
  suffix: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envValue(suffix, env) === value;
}

/** npm spec for MCP snippets, e.g. `@facthouse/mcp@0.26.0`. */
export function npmPackageSpec(version: string | null | undefined): string {
  return version ? `${NPM_PACKAGE}@${version}` : NPM_PACKAGE;
}

/** Env keys that select a store. Tests must strip this prefix. */
export const STORE_ENV_KEYS: readonly string[] = [
  envName("DATA"),
  envName("SUBPROCESS"),
  envName("STORAGE"),
  envName("POSTGRES_URL"),
];

/** Set on the intelligence CLI child so argv0 refuses to recurse. */
export function subprocessGuardEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    [envName("SUBPROCESS")]: "1",
  };
}
