import type { IntelligenceProviderType } from "../types/config.js";
import { envName, envValue } from "../identity.js";

export const VALID_PROVIDER_TYPES: readonly IntelligenceProviderType[] = [
  "heuristic",
  "sampling",
  "cli",
  "api",
  "http",
];

/** Environment kill-switch: force a provider regardless of config.json. */
export const PROVIDER_ENV_VAR = envName("PROVIDER");

export function resolveProviderType(
  configured: IntelligenceProviderType,
  env: NodeJS.ProcessEnv = process.env,
): IntelligenceProviderType {
  const override = envValue("PROVIDER", env)?.toLowerCase();
  if (override && (VALID_PROVIDER_TYPES as readonly string[]).includes(override)) {
    return override as IntelligenceProviderType;
  }
  return configured;
}
