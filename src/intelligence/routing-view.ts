/**
 * Snapshot of intelligence routing for inspect and copy-paste JSON.
 * One definition of what the engine will do, including on_fail defaults.
 */

import { CLI_NAME } from "../identity.js";
import {
  HTTP_DEFAULT_BASE_URL,
  HTTP_WELL_KNOWN_BASE_URLS,
  type IntelligenceConfig,
  type IntelligenceStageName,
  type IntelligenceStageOverride,
  type StageOnFail,
} from "../types/config.js";
import { httpBaseUrlOf, httpModelOf } from "./http.js";
import {
  resolveStageOnFail,
  resolveStageProviderType,
} from "./stage-router.js";

export const INTELLIGENCE_STAGE_NAMES = [
  "extract",
  "summarise",
  "reconcile",
  "supersede",
] as const satisfies readonly IntelligenceStageName[];

export interface StageRoutingView {
  provider: string;
  on_fail: StageOnFail;
}

export interface IntelligenceRoutingView {
  default_provider: string;
  http_base_url: string;
  http_model: string | null;
  stages: Record<IntelligenceStageName, StageRoutingView>;
  well_known: ReadonlyArray<{ host: string; base_url: string }>;
  how_to: string;
}

export const INTELLIGENCE_ROUTING_HOW_TO =
  "Inspect does not save. Copy the JSON into this store's config.json, " +
  `or run ${CLI_NAME} settings on a terminal.`;

export function intelligenceRoutingView(
  config: IntelligenceConfig,
): IntelligenceRoutingView {
  const stages = {} as Record<IntelligenceStageName, StageRoutingView>;
  for (const name of INTELLIGENCE_STAGE_NAMES) {
    stages[name] = {
      provider: resolveStageProviderType(config, name),
      on_fail: resolveStageOnFail(config, name),
    };
  }
  return {
    default_provider: config.provider,
    http_base_url: httpBaseUrlOf(config.http),
    http_model: httpModelOf(config.http),
    stages,
    well_known: HTTP_WELL_KNOWN_BASE_URLS.map((row) => ({
      host: row.host,
      base_url: row.base_url,
    })),
    how_to: INTELLIGENCE_ROUTING_HOW_TO,
  };
}

/** JSON fragment to paste under the top-level config object. */
export function intelligenceRoutingSnippet(view: {
  http_base_url: string;
  http_model: string | null;
  stages: Record<string, { provider: string; on_fail: string }>;
}): string {
  const http: { base_url: string; model?: string } = {
    base_url: view.http_base_url.trim() || HTTP_DEFAULT_BASE_URL,
  };
  const model = view.http_model?.trim();
  if (model) http.model = model;
  const stages: Record<string, IntelligenceStageOverride> = {};
  for (const [name, row] of Object.entries(view.stages)) {
    stages[name] = {
      provider: row.provider as IntelligenceStageOverride["provider"],
      on_fail: row.on_fail as StageOnFail,
    };
  }
  return JSON.stringify({ intelligence: { http, stages } }, null, 2);
}
