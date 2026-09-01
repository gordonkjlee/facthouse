/**
 * Per-stage intelligence routing when HTTP is configured.
 *
 * Engine default (no stages map): extract + summarise on HTTP, reconcile +
 * supersede on cli. Classify/entities follow extract.
 */

import { LOG_PREFIX } from "../identity.js";
import {
  CLI_DEFAULT_MODEL,
  CLI_DEFAULT_TIMEOUT_MS,
  isStageOnFail,
  type IntelligenceConfig,
  type IntelligenceProviderType,
  type IntelligenceStageName,
  type StageOnFail,
} from "../types/config.js";
import type { IntelligenceProvider } from "./types.js";
import type { IntelligenceUsage } from "./usage.js";
import { addOptional } from "./usage.js";
import { createCliProvider } from "./cli.js";
import { createHeuristicProvider } from "./heuristic.js";
import {
  createHttpProvider,
  httpBaseUrlOf,
  httpIsOptedIn,
  httpModelOf,
  resolveHttpChatTarget,
  type HttpFetcher,
} from "./http.js";
import { resolveProviderType } from "./provider-type.js";
import type { DomainDef } from "../types/config.js";

export const DEFAULT_HTTP_STAGES: Record<IntelligenceStageName, "http" | "cli"> = {
  extract: "http",
  summarise: "http",
  reconcile: "cli",
  supersede: "cli",
};

/** I→K stages that share the graduate lock. Classify/entities follow extract. */
export const GRADUATE_STAGE_NAMES = [
  "reconcile",
  "supersede",
  "summarise",
] as const satisfies readonly IntelligenceStageName[];

export function httpIsConfigured(config: IntelligenceConfig): boolean {
  return httpModelOf(config.http) != null;
}

/**
 * Whether this config builds the per-stage router. Kill-switch heuristic /
 * sampling / api never mix with HTTP — that would bill the wrong pot.
 */
function cliGraduateModelDiffers(config: IntelligenceConfig): boolean {
  const graduate = config.cli?.graduate_model?.trim();
  if (!graduate) return false;
  const extract = (config.cli?.model ?? CLI_DEFAULT_MODEL).trim();
  return graduate !== extract;
}

export function usesStageRouter(
  config: IntelligenceConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const type = resolveProviderType(config.provider, env);
  if (type === "heuristic" || type === "sampling" || type === "api") return false;
  return httpIsOptedIn(config) || type === "http" || cliGraduateModelDiffers(config);
}

export function resolveStageProviderType(
  config: IntelligenceConfig,
  stage: IntelligenceStageName,
  env: NodeJS.ProcessEnv = process.env,
): IntelligenceProviderType {
  if (!usesStageRouter(config, env)) {
    return resolveProviderType(config.provider, env);
  }
  const listed = config.stages?.[stage]?.provider;
  if (listed) return listed;
  const anyStages = Boolean(
    config.stages && Object.keys(config.stages).length > 0,
  );
  if (httpIsOptedIn(config) && !anyStages) {
    return DEFAULT_HTTP_STAGES[stage];
  }
  return resolveProviderType(config.provider, env);
}

/**
 * Engine defaults: HTTP extract/summarise retry CLI; contradiction does not
 * switch provider (`none`). Listed `stages.<name>.on_fail` always wins.
 */
export function resolveStageOnFail(
  config: IntelligenceConfig,
  stage: IntelligenceStageName,
  env: NodeJS.ProcessEnv = process.env,
): StageOnFail {
  const listed = config.stages?.[stage]?.on_fail;
  if (isStageOnFail(listed)) return listed;
  const primary = resolveStageProviderType(config, stage, env);
  if (primary === "http" && (stage === "extract" || stage === "summarise")) {
    return "cli";
  }
  return "none";
}

function stageForMethod(
  method: keyof IntelligenceProvider,
): IntelligenceStageName {
  switch (method) {
    case "extractFactsFromEvents":
    case "classifyFacts":
    case "extractEntities":
      return "extract";
    case "summarise":
      return "summarise";
    case "reconcile":
      return "reconcile";
    case "detectSupersession":
      return "supersede";
    default:
      return "extract";
  }
}

function mergeUsage(
  parts: Array<IntelligenceUsage | null | undefined>,
): IntelligenceUsage | null {
  const present = parts.filter((p): p is IntelligenceUsage => Boolean(p));
  if (present.length === 0) return null;
  const stages: IntelligenceUsage["stages"] = {};
  let calls = 0;
  let elapsed = 0;
  let input: number | undefined;
  let output: number | undefined;
  for (const part of present) {
    calls += part.calls;
    elapsed += part.elapsed_ms;
    input = addOptional(input, part.input_tokens);
    output = addOptional(output, part.output_tokens);
    Object.assign(stages, part.stages);
  }
  return {
    calls,
    elapsed_ms: elapsed,
    stages,
    ...(input != null ? { input_tokens: input } : {}),
    ...(output != null ? { output_tokens: output } : {}),
  };
}

/**
 * When HTTP extract cannot run, retry on the CLI (default on). Consolidate
 * turns this off when the CLI token cap would refuse the steal.
 */
const cliExtractFallback = new WeakMap<object, boolean>();

export function setHttpExtractCliFallback(
  provider: IntelligenceProvider,
  allowed: boolean,
): void {
  cliExtractFallback.set(provider, allowed);
}

export interface StageRouterContext {
  heuristic?: IntelligenceProvider;
  vocabulary?: DomainDef[];
  env?: NodeJS.ProcessEnv;
  fetch?: HttpFetcher;
  /** Injected CLI provider (tests). Production constructs one per model. */
  cli?: IntelligenceProvider;
}

export function createStageRouter(
  config: IntelligenceConfig,
  ctx: StageRouterContext = {},
): IntelligenceProvider {
  const vocabulary = ctx.vocabulary ?? [];
  const heuristic = ctx.heuristic ?? createHeuristicProvider(vocabulary);
  const env = ctx.env ?? process.env;
  let resolvedModel = httpModelOf(config.http);
  let baseUrl = httpBaseUrlOf(config.http);
  let discoverAttempted = false;
  const timeoutMs = config.http?.timeout_ms ?? CLI_DEFAULT_TIMEOUT_MS;
  const fetchImpl = ctx.fetch;

  async function ensureHttpModel(): Promise<string | null> {
    if (resolvedModel) return resolvedModel;
    if (discoverAttempted) return null;
    discoverAttempted = true;
    const found = await resolveHttpChatTarget({
      preferredBaseUrl: baseUrl,
      fetchImpl,
    });
    if (found.hint) {
      console.error(`${LOG_PREFIX} ${found.hint}`);
    }
    if (!found.ok || !found.model) return null;
    baseUrl = found.baseUrl;
    resolvedModel = found.model;
    return resolvedModel;
  }
  const httpByModel = new Map<string, IntelligenceProvider>();
  const cliByModel = new Map<string, IntelligenceProvider>();

  function httpFor(model: string): IntelligenceProvider {
    const existing = httpByModel.get(model);
    if (existing) return existing;
    const created = createHttpProvider(
      { baseUrl, model, timeoutMs, fetch: ctx.fetch },
      heuristic,
      vocabulary,
    );
    httpByModel.set(model, created);
    return created;
  }

  function cliFor(model: string | undefined): IntelligenceProvider {
    if (ctx.cli) return ctx.cli;
    const key = (model ?? config.cli?.model ?? "").trim();
    const existing = cliByModel.get(key);
    if (existing) return existing;
    const created = createCliProvider(
      {
        command: config.cli?.command,
        model: key || undefined,
        timeoutMs: config.cli?.timeout_ms,
        debug: config.cli?.debug,
      },
      heuristic,
      vocabulary,
    );
    cliByModel.set(key, created);
    return created;
  }

  const pick = (method: keyof IntelligenceProvider): IntelligenceProvider => {
    const stage = stageForMethod(method);
    const type = resolveStageProviderType(config, stage, env);
    const modelOverride = config.stages?.[stage]?.model?.trim();
    if (type === "http") {
      const model = modelOverride || resolvedModel;
      if (!model) return heuristic;
      return httpFor(model);
    }
    if (type === "cli") {
      const graduate =
        stage === "summarise" ||
        stage === "reconcile" ||
        stage === "supersede";
      return cliFor(
        modelOverride ||
          (graduate ? config.cli?.graduate_model?.trim() : undefined) ||
          config.cli?.model,
      );
    }
    return heuristic;
  };

  const self: IntelligenceProvider = {
    async extractFactsFromEvents(...args) {
      const type = resolveStageProviderType(config, "extract", env);
      let out;
      if (type === "http") {
        const model =
          config.stages?.extract?.model?.trim() || (await ensureHttpModel());
        if (!model) {
          return { facts: [], degraded: true };
        }
        out = await httpFor(model).extractFactsFromEvents(...args);
      } else {
        out = await pick("extractFactsFromEvents").extractFactsFromEvents(
          ...args,
        );
      }
      if (!out.degraded) return out;
      const fail = resolveStageOnFail(config, "extract", env);
      if (fail === "none" || fail === type) return out;
      if (fail === "cli") {
        if (!(cliExtractFallback.get(self) ?? true)) {
          console.error(
            `${LOG_PREFIX} http extract failed — CLI fallback is blocked`,
          );
          return out;
        }
        console.error(
          `${LOG_PREFIX} extract failed — retrying on the CLI`,
        );
        return cliFor(config.cli?.model).extractFactsFromEvents(...args);
      }
      const model = await ensureHttpModel();
      if (!model) return out;
      console.error(`${LOG_PREFIX} extract failed — retrying on HTTP`);
      return httpFor(model).extractFactsFromEvents(...args);
    },
    classifyFacts: (...args) => pick("classifyFacts").classifyFacts(...args),
    extractEntities: (...args) => pick("extractEntities").extractEntities(...args),
    reconcile: (...args) => pick("reconcile").reconcile(...args),
    detectSupersession: (...args) =>
      pick("detectSupersession").detectSupersession(...args),
    async summarise(...args) {
      const type = resolveStageProviderType(config, "summarise", env);
      if (type !== "http") return pick("summarise").summarise(...args);
      const model =
        config.stages?.summarise?.model?.trim() || (await ensureHttpModel());
      if (!model) return heuristic.summarise(...args);
      return httpFor(model).summarise(...args);
    },
    takeUsage(): IntelligenceUsage | null {
      return mergeUsage([
        ...[...cliByModel.values()].map((p) => p.takeUsage?.() ?? null),
        ...[...httpByModel.values()].map((p) => p.takeUsage?.() ?? null),
        ctx.cli?.takeUsage?.() ?? null,
      ]);
    },
  };
  return self;
}
