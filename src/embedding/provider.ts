/**
 * Embedding provider selector.
 *
 * Mirrors `src/intelligence/provider.ts` — same env kill-switch, same
 * resolve-once-at-startup shape — with one deliberate difference: there is **no
 * terminal fallback**. The intelligence layer always resolves to something,
 * because consolidation must produce facts either way. Embeddings have no
 * equivalent floor: a wrong-model vector is worse than no vector, since it
 * enters the same space as the good ones and silently corrupts every comparison
 * against them. So an unconfigured or unresolvable provider returns null and
 * search stays keyword-only.
 */

import type { EmbeddingProvider } from "./types.js";
import type { EmbeddingConfig, EmbeddingProviderType } from "../types/config.js";
import { createOllamaProvider } from "./ollama.js";
import { createVoyageProvider } from "./voyage.js";

const VALID_TYPES: readonly EmbeddingProviderType[] = ["voyage", "ollama"];

/** Environment kill-switch: force a provider, or `none` to turn it off. */
export const EMBEDDING_PROVIDER_ENV = "OPENMEMORY_EMBEDDING_PROVIDER";

/**
 * Resolve the effective provider type. `none` is accepted explicitly so a
 * store with semantic search configured can be run without it — the same
 * escape hatch `OPENMEMORY_PROVIDER=heuristic` gives the intelligence layer.
 */
export function resolveEmbeddingProviderType(
  configured: EmbeddingProviderType | null,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProviderType | null {
  const override = env[EMBEDDING_PROVIDER_ENV]?.trim().toLowerCase();
  if (override === "none") return null;
  if (override && (VALID_TYPES as readonly string[]).includes(override)) {
    return override as EmbeddingProviderType;
  }
  return configured;
}

export interface EmbeddingProviderContext {
  env?: NodeJS.ProcessEnv;
  /** Report why no provider was built. Silent by default. */
  onUnavailable?: (reason: string) => void;
}

/**
 * Build the embedding provider, or null when semantic search is off.
 *
 * Null is a normal outcome, not an error: `provider: null` is the shipped
 * default. The `onUnavailable` callback exists to separate "deliberately off"
 * from "configured but broken" — a store whose key env var is unset should be
 * able to say so rather than silently behaving like an unconfigured one.
 */
export function createEmbeddingProvider(
  config: EmbeddingConfig | undefined,
  ctx: EmbeddingProviderContext = {},
): EmbeddingProvider | null {
  const env = ctx.env ?? process.env;
  const say = ctx.onUnavailable ?? (() => {});

  const type = resolveEmbeddingProviderType(config?.provider ?? null, env);
  if (!type) return null;

  const dimensions = config?.dimensions ?? null;

  if (type === "ollama") {
    return createOllamaProvider({
      host: config?.host,
      model: config?.model ?? undefined,
      dimensions,
    });
  }

  // voyage
  const keyVar = config?.api_key_env ?? "VOYAGE_API_KEY";
  const apiKey = env[keyVar];
  if (!apiKey) {
    // Configured but unusable. Reported rather than silently downgraded — a
    // store that thinks it has semantic search and does not is exactly the
    // kind of quiet gap this codebase keeps finding.
    say(`embedding provider "voyage" is configured but ${keyVar} is not set`);
    return null;
  }

  return createVoyageProvider({
    apiKey,
    model: config?.model ?? undefined,
    dimensions,
  });
}
