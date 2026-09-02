/**
 * OpenAI-compatible HTTP intelligence (Ollama / LM Studio / vLLM / llama.cpp).
 *
 * Chat completions + JSON mode. Not Ollama's native generate API, and not the
 * embedding provider — those fail differently.
 */

import { LOG_PREFIX } from "../identity.js";
import {
  CLI_DEFAULT_TIMEOUT_MS,
  HTTP_DEFAULT_BASE_URL,
  HTTP_WELL_KNOWN_BASE_URLS,
  type DomainDef,
  type HttpProviderConfig,
} from "../types/config.js";
import type {
  ExtractedEntity,
  ExtractedFact,
  IntelligenceProvider,
  Referent,
} from "./types.js";
import { parseExtractedIso } from "./extract-prompt.js";
import {
  EXTRACT_CONTEXT_CONTRACT,
  EXTRACT_DURABLE_JOB,
  SUBJECT_MARKING_CONTRACT,
  entityTypeInstruction,
  extractEventPayload,
  extractTodayUtcDate,
} from "./extract-prompt.js";
import { domainRoutingInstruction, normaliseDomainName } from "../schemas/domains.js";
import { UsageAccumulator, addOptional, type IntelligenceUsage } from "./usage.js";
import { createHeuristicProvider } from "./heuristic.js";

export function httpModelOf(config: HttpProviderConfig | undefined): string | null {
  const model = config?.model?.trim();
  return model ? model : null;
}

export function httpBaseUrlOf(config: HttpProviderConfig | undefined): string {
  const raw = config?.base_url?.trim() || HTTP_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** True when the store asked for HTTP, even if the model is not pinned yet. */
export function httpIsOptedIn(config: {
  http?: HttpProviderConfig;
  provider?: string;
}): boolean {
  if (httpModelOf(config.http) != null) return true;
  if (config.http?.base_url?.trim()) return true;
  return config.provider === "http";
}

const HTTP_PROBE_TIMEOUT_MS = 800;

export function isEmbedOnlyModel(id: string): boolean {
  return /embed/i.test(id);
}

export function partitionHttpModels(ids: string[]): {
  chat: string[];
  embed: string[];
} {
  const chat: string[] = [];
  const embed: string[] = [];
  for (const id of ids) {
    if (isEmbedOnlyModel(id)) embed.push(id);
    else chat.push(id);
  }
  return { chat, embed };
}

function parseModelsList(text: string): string[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [];
  }
  if (!body || typeof body !== "object") return [];
  const rec = body as Record<string, unknown>;
  const fromData = Array.isArray(rec.data)
    ? rec.data
        .map((row) =>
          row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
            ? (row as { id: string }).id
            : "",
        )
        .filter(Boolean)
    : [];
  if (fromData.length > 0) return fromData;
  const models = rec.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((row) => {
      if (typeof row === "string") return row;
      if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") {
        return (row as { id: string }).id;
      }
      if (row && typeof row === "object" && typeof (row as { name?: unknown }).name === "string") {
        return (row as { name: string }).name;
      }
      return "";
    })
    .filter(Boolean);
}

export async function probeHttpModels(
  baseUrl: string,
  fetchImpl: HttpFetcher = fetch,
  timeoutMs = HTTP_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; baseUrl: string; ids: string[] }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, baseUrl, ids: [] };
    const ids = parseModelsList(await res.text());
    return { ok: true, baseUrl, ids };
  } catch {
    return { ok: false, baseUrl, ids: [] };
  }
}

export function wellKnownHttpUrlHint(): string {
  return HTTP_WELL_KNOWN_BASE_URLS.map((row) => `${row.host} ${row.base_url}`).join(
    "; ",
  );
}

export function httpExtractFailHint(baseUrl: string): string {
  return (
    `Nothing usable at ${baseUrl}. OpenAI-compat chat is POST /v1/chat/completions; ` +
    `typical roots: ${wellKnownHttpUrlHint()}. A running host lists names at GET {base}/models ` +
    `(chat models, not nomic-embed-text). Set intelligence.http.base_url and ` +
    `intelligence.http.model in this store's config.json.`
  );
}

export function formatHttpModelHint(opts: {
  baseUrl: string;
  chat: string[];
  embed: string[];
}): string {
  const embedNote =
    opts.embed.length > 0 ? ` Embed-only (not extract): ${opts.embed.join(", ")}.` : "";
  if (opts.chat.length === 0) {
    return (
      `Host at ${opts.baseUrl} answered but listed no chat model.${embedNote} ` +
      `Set intelligence.http.model to a chat model.`
    );
  }
  if (opts.chat.length === 1) {
    return (
      `Using ${opts.chat[0]} at ${opts.baseUrl} for this run. Pin ` +
      `intelligence.http.model in config.json so the next run does not guess.`
    );
  }
  return (
    `Host at ${opts.baseUrl} lists chat models: ${opts.chat.join(", ")}.` +
    `${embedNote} Set intelligence.http.model to one of those.`
  );
}

export interface ResolvedHttpTarget {
  ok: boolean;
  baseUrl: string;
  model: string | null;
  hint: string;
}

export async function resolveHttpChatTarget(opts: {
  preferredBaseUrl: string;
  fetchImpl?: HttpFetcher;
}): Promise<ResolvedHttpTarget> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const preferred = opts.preferredBaseUrl.replace(/\/+$/, "");
  const primary = await probeHttpModels(preferred, fetchImpl);
  if (primary.ok) {
    const parts = partitionHttpModels(primary.ids);
    if (parts.chat.length === 1) {
      return {
        ok: true,
        baseUrl: preferred,
        model: parts.chat[0]!,
        hint: formatHttpModelHint({ baseUrl: preferred, ...parts }),
      };
    }
    return {
      ok: false,
      baseUrl: preferred,
      model: null,
      hint: formatHttpModelHint({ baseUrl: preferred, ...parts }),
    };
  }
  const others = HTTP_WELL_KNOWN_BASE_URLS.map((row) => row.base_url).filter(
    (url) => url !== preferred,
  );
  const probed = await Promise.all(
    others.map((url) => probeHttpModels(url, fetchImpl)),
  );
  const hit = probed.find((row) => row.ok);
  if (hit) {
    const parts = partitionHttpModels(hit.ids);
    if (parts.chat.length === 1) {
      return {
        ok: true,
        baseUrl: hit.baseUrl,
        model: parts.chat[0]!,
        hint: formatHttpModelHint({ baseUrl: hit.baseUrl, ...parts }),
      };
    }
    return {
      ok: false,
      baseUrl: hit.baseUrl,
      model: null,
      hint: formatHttpModelHint({ baseUrl: hit.baseUrl, ...parts }),
    };
  }
  return {
    ok: false,
    baseUrl: preferred,
    model: null,
    hint: httpExtractFailHint(preferred),
  };
}

export interface HttpChatResult {
  json: unknown;
  input_tokens?: number;
  output_tokens?: number;
  elapsed_ms: number;
}

export type HttpFetcher = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface HttpProviderOpts {
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  fetch?: HttpFetcher;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseHttpUsage(body: Record<string, unknown>): {
  input_tokens?: number;
  output_tokens?: number;
} {
  const usage = body.usage;
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  const input = addOptional(
    asFiniteNumber(u.prompt_tokens),
    asFiniteNumber(u.input_tokens),
  );
  const output = addOptional(
    asFiniteNumber(u.completion_tokens),
    asFiniteNumber(u.output_tokens),
  );
  return {
    ...(input != null ? { input_tokens: input } : {}),
    ...(output != null ? { output_tokens: output } : {}),
  };
}

export async function httpChatJson(
  opts: {
    baseUrl: string;
    model: string;
    prompt: string;
    timeoutMs: number;
    fetchImpl: HttpFetcher;
  },
): Promise<HttpChatResult> {
  const started = Date.now();
  const url = `${opts.baseUrl}/chat/completions`;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await opts.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: opts.prompt }],
      }),
      signal,
    });
  } catch (err) {
    const elapsed_ms = Date.now() - started;
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw Object.assign(new Error("http timeout"), { elapsed_ms });
    }
    throw Object.assign(
      new Error(err instanceof Error ? err.message : String(err)),
      { elapsed_ms },
    );
  }
  const elapsed_ms = Date.now() - started;
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`http ${response.status}`), { elapsed_ms });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("http non-json envelope"), { elapsed_ms });
  }
  const choices = body.choices;
  const content =
    Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
      ? (choices[0] as { message?: { content?: unknown } }).message?.content
      : undefined;
  if (typeof content !== "string") {
    throw Object.assign(new Error("http empty content"), { elapsed_ms });
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw Object.assign(new Error("http non-json content"), { elapsed_ms });
  }
  return { json, elapsed_ms, ...parseHttpUsage(body) };
}

export function createHttpProvider(
  userOpts: HttpProviderOpts,
  fallback: IntelligenceProvider = createHeuristicProvider(),
  vocabulary: DomainDef[] = [],
): IntelligenceProvider {
  const baseUrl = (userOpts.baseUrl ?? HTTP_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = userOpts.model;
  const timeoutMs = userOpts.timeoutMs ?? CLI_DEFAULT_TIMEOUT_MS;
  const fetchImpl = userOpts.fetch ?? fetch;
  const usageAcc = new UsageAccumulator({ provider: "http", model });

  async function runStage(stageName: string, prompt: string): Promise<unknown | null> {
    try {
      const result = await httpChatJson({
        baseUrl,
        model,
        prompt,
        timeoutMs,
        fetchImpl,
      });
      usageAcc.record(stageName, {
        provider: "http",
        model,
        elapsed_ms: result.elapsed_ms,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
      });
      return result.json;
    } catch (err) {
      const elapsed_ms =
        err && typeof err === "object" && "elapsed_ms" in err
          ? Number((err as { elapsed_ms: number }).elapsed_ms)
          : 0;
      usageAcc.record(stageName, { provider: "http", model, elapsed_ms });
      console.error(
        `${LOG_PREFIX} http ${stageName}:`,
        err instanceof Error ? err.message : err,
      );
      if (stageName === "stage-1-extract") {
        console.error(`${LOG_PREFIX} ${httpExtractFailHint(baseUrl)}`);
      }
      return null;
    }
  }

  return {
    async extractFactsFromEvents(events, workingMemory, sessionSummary, longTermMemory, extras) {
      if (events.length === 0) return { facts: [], degraded: false };
      const json = await runStage(
        "stage-1-extract",
        EXTRACT_DURABLE_JOB +
          " " +
          `${domainRoutingInstruction(extras?.vocabulary ?? vocabulary)} ` +
          "optional subdomain, confidence 0-1, importance 0-1, and any named " +
          "things mentioned (people, organisations, places, projects, products, " +
          "systems, concepts — whatever the fact concerns), each with a short lowercase type. " +
          `${entityTypeInstruction(extras?.entityTypes ?? [])} ` +
          SUBJECT_MARKING_CONTRACT +
          " " +
          EXTRACT_CONTEXT_CONTRACT +
          " " +
          "If an entity matches one of the entities referenced in long_term_memory (by name or " +
          "clear reference), set existing_id to the matching id; otherwise omit existing_id " +
          "(= new entity). " +
          "Return strictly {facts: [...], session_now?, referents?, topic_shifted?, confidence?}." +
          `\n\nINPUT:\n${JSON.stringify({
            session_now: extras?.now ?? null,
            referents: extras?.referents ?? [],
            topic_segments: extras?.segments ?? [],
            session_summary: sessionSummary ?? null,
            long_term_memory: (longTermMemory ?? []).map((f) => ({
              id: f.id,
              content: f.content,
              domain: f.domain,
            })),
            extract_today: extractTodayUtcDate(),
            recent_events: workingMemory.map(extractEventPayload),
            reminder_events: (extras?.reminderEvents ?? []).map(extractEventPayload),
            candidate_events: events.map(extractEventPayload),
          })}`,
      );
      const facts = (json as { facts?: unknown } | null)?.facts;
      if (!json || !Array.isArray(facts)) {
        return { facts: [], degraded: true };
      }
      const extracted: ExtractedFact[] = facts.map((raw) => {
        const f = raw as {
          content: string;
          domain: string;
          subdomain?: string | null;
          confidence?: number;
          importance?: number;
          capture_context?: string | null;
          valid_from?: string | null;
          valid_until?: string | null;
          entities?: Array<{
            name: string;
            type: string;
            relationship: string;
            existing_id?: string | null;
          }>;
        };
        return {
          content: f.content,
          domain_hint: f.domain,
          subdomain_hint: f.subdomain ?? null,
          confidence_signal: typeof f.confidence === "number" ? f.confidence : null,
          importance_signal: typeof f.importance === "number" ? f.importance : null,
          capture_context: f.capture_context ?? null,
          valid_from: parseExtractedIso(f.valid_from),
          valid_until: parseExtractedIso(f.valid_until),
          entities: Array.isArray(f.entities)
            ? f.entities.map((e) => ({
                name: e.name,
                type: e.type,
                relationship: e.relationship,
                existing_id: e.existing_id ?? undefined,
              }))
            : [],
          source_quality: "http",
        };
      });
      const result = json as {
        session_now?: string | null;
        referents?: Referent[];
        topic_shifted?: boolean;
        confidence?: number;
      };
      return {
        facts: extracted,
        degraded: false,
        now: result.session_now,
        referents: Array.isArray(result.referents) ? result.referents : undefined,
        topic_shifted: result.topic_shifted,
        confidence:
          typeof result.confidence === "number" ? result.confidence : undefined,
      };
    },

    async classifyFacts(facts, sessionContext) {
      if (facts.length === 0) return [];
      const json = await runStage(
        "stage-classify",
        "You route already-extracted facts into domains. " +
          `${domainRoutingInstruction(vocabulary)} ` +
          "Also give an optional short lowercase subdomain where one is " +
          "genuinely useful, or null. " +
          "Return a classification for EVERY fact you are given, keyed by its " +
          "id. Return strictly {classifications: [{id, domain, subdomain}]}." +
          `\n\nINPUT:\n${JSON.stringify({
            session_context: sessionContext ?? null,
            facts: facts.map((f) => ({
              id: f.id,
              content: f.content,
              domain_hint: f.domain_hint ?? null,
            })),
          })}`,
      );
      const classifications = (json as { classifications?: unknown } | null)
        ?.classifications;
      if (!json || !Array.isArray(classifications)) {
        return fallback.classifyFacts(facts, sessionContext);
      }
      const byId = new Map(
        (classifications as Array<{ id: string; domain: string; subdomain?: string | null }>).map(
          (c) => [c.id, c],
        ),
      );
      const missing = facts.filter((f) => !byId.has(f.id));
      const heuristicForMissing = missing.length
        ? await fallback.classifyFacts(missing, sessionContext)
        : [];
      const heuristicById = new Map(heuristicForMissing.map((c) => [c.id, c]));
      return facts.map((f) => {
        const c = byId.get(f.id);
        if (!c) return heuristicById.get(f.id)!;
        return {
          id: f.id,
          content: f.content,
          domain: normaliseDomainName(c.domain),
          subdomain: c.subdomain ?? null,
        };
      });
    },

    async extractEntities(facts) {
      if (facts.length === 0) return new Map();
      const json = await runStage(
        "stage-entities",
        "You identify the named things each fact concerns — people, " +
          "organisations, places, projects, products, systems, concepts — " +
          "whatever the fact is about, each with a short lowercase type. " +
          SUBJECT_MARKING_CONTRACT +
          " " +
          "Return an entry for every fact, with an empty list where a fact " +
          "names nothing. Return strictly {facts: [{id, entities}]}." +
          `\n\nINPUT:\n${JSON.stringify({
            facts: facts.map((f) => ({ id: f.id, content: f.content })),
          })}`,
      );
      const rows = (json as { facts?: unknown } | null)?.facts;
      if (!json || !Array.isArray(rows)) {
        return fallback.extractEntities(facts);
      }
      const map = new Map<string, ExtractedEntity[]>();
      for (const row of rows as Array<{
        id: string;
        entities?: ExtractedEntity[];
      }>) {
        if (!Array.isArray(row.entities) || row.entities.length === 0) continue;
        map.set(row.id, row.entities);
      }
      return map;
    },

    async reconcile(candidate, existingFacts) {
      if (existingFacts.length === 0) return { kind: "add" };
      const json = await runStage(
        "stage-2-reconcile",
        "You decide whether a candidate fact is already covered by an existing fact. " +
          "'noop' = the EXACT same information exists. " +
          "'enrich' = a paraphrase or corroboration of a specific existing fact — " +
          "set existingFactId to that fact's id. " +
          "'add' = the candidate adds something new or stands alone. " +
          "Supersession (contradictions) is handled separately — treat contradictions as 'add'. " +
          "Return strictly {decisions: [{id, decision, existingFactId?}]}." +
          `\n\nINPUT:\n${JSON.stringify({
            candidates: [{ id: candidate.id, content: candidate.content }],
            existing: existingFacts.map((f) => ({ id: f.id, content: f.content })),
          })}`,
      );
      const decisions = (json as { decisions?: unknown } | null)?.decisions;
      if (!json || !Array.isArray(decisions) || decisions.length === 0) {
        return fallback.reconcile(candidate, existingFacts);
      }
      const decision = decisions[0] as {
        decision?: string;
        existingFactId?: string | null;
      };
      if (decision.decision === "noop") return { kind: "noop" };
      if (decision.decision === "enrich" && typeof decision.existingFactId === "string") {
        const exists = existingFacts.some((f) => f.id === decision.existingFactId);
        return exists
          ? { kind: "enrich", existingFactId: decision.existingFactId }
          : { kind: "add" };
      }
      return { kind: "add" };
    },

    async detectSupersession(newFact, existingFacts) {
      const candidates = existingFacts.filter(
        (f) => f.domain === newFact.domain && f.status === "active" && f.is_latest,
      );
      if (candidates.length === 0) return null;
      const json = await runStage(
        "stage-3-supersede",
        "You detect whether a new fact supersedes (invalidates and replaces) an existing one. " +
          "Supersession applies for negations, updates, or replacements. " +
          "Paraphrase or additional detail is NOT supersession. " +
          "Return strictly {supersessions: [{new_id, existing_id, reason}]} — " +
          "omit entries where no supersession applies." +
          `\n\nINPUT:\n${JSON.stringify({
            new: [{ id: newFact.id, content: newFact.content, domain: newFact.domain }],
            existing: candidates.map((f) => ({ id: f.id, content: f.content })),
          })}`,
      );
      const supersessions = (json as { supersessions?: unknown } | null)?.supersessions;
      if (!json || !Array.isArray(supersessions)) {
        return fallback.detectSupersession(newFact, existingFacts);
      }
      const hit = (
        supersessions as Array<{ new_id: string; existing_id: string; reason: string }>
      ).find((s) => s.new_id === newFact.id);
      if (!hit) return null;
      const exists = candidates.some((f) => f.id === hit.existing_id);
      if (!exists) return null;
      return { existingFactId: hit.existing_id, reason: hit.reason };
    },

    async summarise(sessionFacts, integratedFacts, priorSummary, closedTopics) {
      if (integratedFacts.length === 0) {
        return { summary: "No facts integrated.", openThreads: [] };
      }
      const json = await runStage(
        "stage-4-summarise",
        "You summarise a consolidation run. " +
          "Produce a CUMULATIVE summary that folds what was just learned " +
          "into prior_summary — one natural paragraph — and list up to 5 open threads. " +
          "Return strictly {summary, openThreads}." +
          `\n\nINPUT:\n${JSON.stringify({
            prior_summary: priorSummary ?? null,
            closed_topics: closedTopics ?? [],
            integrated: integratedFacts.map((f) => ({
              content: f.content,
              domain: f.domain,
              subdomain: f.subdomain,
            })),
          })}`,
      );
      const result = json as { summary?: unknown; openThreads?: unknown } | null;
      if (
        !result ||
        typeof result.summary !== "string" ||
        !Array.isArray(result.openThreads)
      ) {
        return fallback.summarise(sessionFacts, integratedFacts, priorSummary);
      }
      return {
        summary: result.summary,
        openThreads: result.openThreads as string[],
      };
    },

    takeUsage(): IntelligenceUsage | null {
      return usageAcc.take();
    },
  };
}
