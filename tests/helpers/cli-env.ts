/**
 * Env vars that select a store. Subprocess tests must drop them or a
 * developer's machine leaks into assertions.
 */
import { STORE_ENV_KEYS } from "../../src/identity.js";

export function withoutStoreEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of STORE_ENV_KEYS) delete env[key];
  return env;
}
