/**
 * Env vars that select a store. Subprocess tests must drop them or a
 * developer's machine leaks into assertions.
 */
const STORE_ENV = [
  "OPENMEMORY_DATA",
  "OPENMEMORY_SUBPROCESS",
  "OPENMEMORY_STORAGE",
  "OPENMEMORY_POSTGRES_URL",
] as const;

export function withoutStoreEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of STORE_ENV) delete env[key];
  return env;
}
