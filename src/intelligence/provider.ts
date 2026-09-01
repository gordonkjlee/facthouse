/**
 * Intelligence provider selector.
 *
 * Maps the configured provider type to a concrete IntelligenceProvider,
 * honouring an environment kill-switch that overrides the config file
 * (config precedence: CLI/config file < FACTMEM_PROVIDER env var — the
 * server's three-layer config model, applied to provider selection).
 *
 * The heuristic provider is the universal terminal fallback: it has zero
 * dependencies and always resolves, so every other provider degrades to it
 * rather than to another remote/subprocess provider (which could loop or
 * compound failures). Selection resolves once at startup.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { IntelligenceProvider } from "./types.js";
import type { IntelligenceConfig } from "../types/config.js";
import { createHeuristicProvider } from "./heuristic.js";
import { createSamplingProvider } from "./sampling.js";
import { createCliProvider } from "./cli.js";
import type { DomainDef } from "../types/config.js";
import { LOG_PREFIX } from "../identity.js";
import { resolveProviderType } from "./provider-type.js";
import { createStageRouter, usesStageRouter } from "./stage-router.js";
import type { HttpFetcher } from "./http.js";

export { PROVIDER_ENV_VAR, resolveProviderType } from "./provider-type.js";

export interface ProviderContext {
  /** MCP server — required for the sampling provider. Absent in CLI contexts,
   *  where a `sampling` selection degrades to heuristic (no client to sample). */
  server?: Server | null;
  /** Shared heuristic fallback instance. Created on demand if omitted. */
  heuristic?: IntelligenceProvider;
  /**
   * The store's configured domain vocabulary, for the fallback classifier.
   *
   * The engine ships none — a keyword classifier's keywords are not universal
   * ("allergic" is noise in a corporate store), so they travel with the
   * vocabulary in the user's config. Omitted means the fallback routes
   * everything to `general`, which is the honest answer for a keyword matcher
   * with no keywords.
   */
  vocabulary?: DomainDef[];
  /** Override the env used for the kill-switch (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected HTTP client for tests. */
  fetch?: HttpFetcher;
  /** Injected CLI provider (tests). Production constructs one per model. */
  cli?: IntelligenceProvider;
}

/**
 * Build the intelligence provider for the given config and runtime context.
 * `cli` is the default — real LLM consolidation via the user's
 * own Claude subscription, with per-stage heuristic fallback built in.
 */
export function createIntelligenceProvider(
  config: IntelligenceConfig,
  ctx: ProviderContext = {},
): IntelligenceProvider {
  const vocabulary = ctx.vocabulary ?? [];
  const heuristic = ctx.heuristic ?? createHeuristicProvider(vocabulary);
  const type = resolveProviderType(config.provider, ctx.env);

  if (usesStageRouter(config, ctx.env)) {
    return createStageRouter(config, { ...ctx, heuristic, vocabulary });
  }
  if (type === "heuristic") return heuristic;
  if (type === "sampling") {
    return ctx.server
      ? createSamplingProvider(ctx.server, heuristic, vocabulary)
      : heuristic;
  }
  if (type === "api") {
    console.error(
      `${LOG_PREFIX} intelligence.provider "api" is not implemented — using the heuristic`,
    );
    return heuristic;
  }
  const c = config.cli ?? {};
  return createCliProvider(
    {
      command: c.command,
      model: c.model,
      timeoutMs: c.timeout_ms,
      debug: c.debug,
    },
    heuristic,
    vocabulary,
  );
}
