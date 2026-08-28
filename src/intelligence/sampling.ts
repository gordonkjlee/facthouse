/**
 * MCP sampling intelligence provider.
 *
 * Asks the host LLM (the same model the user is already talking to) to perform
 * classification / entity extraction / reconciliation / supersession detection
 * via MCP sampling (`server.createMessage`). This lets OpenMemory do real LLM
 * intelligence with zero API keys — the client's subscription pays for the calls.
 *
 * Each method is wrapped in a try/catch that falls back to the heuristic
 * provider for that single method on any failure (sampling not supported,
 * network error, malformed JSON response). Consolidation never blocks on a
 * sampling call — a degraded result is better than no result.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  IntelligenceProvider,
  ClassifiedFact,
  ExtractedEntity,
  ExtractionOutcome,
  SupersessionCandidate,
  ReconcileDecision,
  SessionSummary,
  Referent,
} from "./types.js";
import { createHeuristicProvider } from "./heuristic.js";
import { domainRoutingInstruction } from "../schemas/domains.js";
import type { DomainDef } from "../types/config.js";
import {
  EXTRACT_CONTEXT_CONTRACT,
  EXTRACT_DURABLE_JOB,
  SUBJECT_MARKING_CONTRACT,
  entityTypeInstruction,
  extractEventPayload,
  extractTodayUtcDate,
  parseExtractedIso,
} from "./extract-prompt.js";

// Conservative token budgets. Prompts are short; responses are JSON-only.
const DEFAULT_MAX_TOKENS = 2048;

/** Extract text from a createMessage result, or throw if shape is unexpected. */
function readText(result: { content: { type: string; text?: string } }): string {
  if (result.content.type !== "text" || typeof result.content.text !== "string") {
    throw new Error(`Expected text content, got ${result.content.type}`);
  }
  return result.content.text;
}

interface ShapedExtract {
  facts: Array<{
    content: string;
    domain_hint: string | null;
    valid_from: string | null;
    valid_until: string | null;
  }>;
  now?: string | null;
  referents?: Referent[];
  topic_shifted?: boolean;
  confidence?: number;
}

function asReferents(value: unknown): Referent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Referent[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as Referent).phrase === "string" &&
      typeof (item as Referent).binding === "string"
    ) {
      out.push({
        phrase: (item as Referent).phrase,
        binding: (item as Referent).binding,
      });
    }
  }
  return out;
}

/**
 * Object shape is current. A JSON array of facts is the previous sampling
 * contract — treat as facts-only, confident, now unchanged.
 */
function shapeExtractPayload(parsed: unknown): ShapedExtract {
  if (Array.isArray(parsed)) {
    return {
      facts: parsed.map((p: {
        content?: string;
        domain_hint?: string | null;
        valid_from?: unknown;
        valid_until?: unknown;
      }) => ({
        content: typeof p?.content === "string" ? p.content : "",
        domain_hint: p?.domain_hint ?? null,
        valid_from: parseExtractedIso(p?.valid_from),
        valid_until: parseExtractedIso(p?.valid_until),
      })).filter((p) => p.content),
    };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { facts?: unknown }).facts)) {
    throw new Error("sampling: unparseable extraction output");
  }
  const obj = parsed as {
    facts: Array<{
      content?: string;
      domain_hint?: string | null;
      valid_from?: unknown;
      valid_until?: unknown;
    }>;
    session_now?: string | null;
    now?: string | null;
    referents?: unknown;
    topic_shifted?: boolean;
    confidence?: number;
  };
  const facts = obj.facts
    .map((p) => ({
      content: typeof p?.content === "string" ? p.content : "",
      domain_hint: p?.domain_hint ?? null,
      valid_from: parseExtractedIso(p?.valid_from),
      valid_until: parseExtractedIso(p?.valid_until),
    }))
    .filter((p) => p.content);
  const now = obj.session_now ?? obj.now;
  const confidence =
    typeof obj.confidence === "number" ? obj.confidence : undefined;
  return {
    facts,
    now,
    referents: asReferents(obj.referents),
    topic_shifted: obj.topic_shifted === true ? true : obj.topic_shifted === false ? false : undefined,
    confidence,
  };
}

/** Strip ```json fences if the model returns a fenced block. */
function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
    : trimmed;
  return JSON.parse(unfenced) as T;
}

/** Wrap a sampling call and fall back to `fallbackFn()` on any failure. */
async function withFallback<T>(
  attempt: () => Promise<T>,
  fallbackFn: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch {
    return fallbackFn();
  }
}

export function createSamplingProvider(
  server: Server,
  fallback: IntelligenceProvider = createHeuristicProvider(),
  /** The store's configured vocabulary, named in the routing prompt. */
  vocabulary: DomainDef[] = [],
): IntelligenceProvider {
  // Capability is checked per call rather than at construction, because the
  // provider is instantiated before the MCP handshake completes.
  // getClientCapabilities() returns the client's advertised capabilities once
  // initialize has been processed.
  async function ask(
    systemPrompt: string,
    userText: string,
  ): Promise<string> {
    const capabilities = server.getClientCapabilities();
    if (!capabilities?.sampling) throw new Error("Sampling unavailable");
    const result = await server.createMessage({
      systemPrompt,
      maxTokens: DEFAULT_MAX_TOKENS,
      messages: [
        { role: "user", content: { type: "text", text: userText } },
      ],
    });
    return readText(result);
  }

  return {
    async classifyFacts(facts, sessionContext) {
      if (facts.length === 0) return [];
      return withFallback(
        async () => {
          const payload = facts.map((f) => ({
            id: f.id,
            content: f.content,
            domain_hint: f.domain_hint,
          }));
          const context = sessionContext ? `\n\nSession context:\n${sessionContext}` : "";
          const raw = await ask(
            "You classify user facts into memory domains. " +
              `${domainRoutingInstruction(vocabulary)} ` +
              "Choose the best domain per fact. Optional subdomain is a short tag. " +
              "Respond with JSON only: an array of {id, domain, subdomain} objects. " +
              "subdomain may be null. No prose.",
            `Classify these facts:\n${JSON.stringify(payload)}${context}`,
          );
          const parsed = parseJson<ClassifiedFact[]>(raw);
          // Preserve input order and content — only trust the model's classification.
          const byId = new Map(parsed.map((c) => [c.id, c]));
          return facts.map((f) => {
            const c = byId.get(f.id);
            return {
              id: f.id,
              content: f.content,
              domain: c?.domain ?? "general",
              subdomain: c?.subdomain ?? null,
            };
          });
        },
        () => fallback.classifyFacts(facts, sessionContext),
      );
    },

    async extractEntities(facts) {
      if (facts.length === 0) return new Map();
      return withFallback(
        async () => {
          const payload = facts.map((f) => ({ id: f.id, content: f.content }));
          const raw = await ask(
            "You extract the named things (entities) from facts. An entity is " +
              "any subject the knowledge is about: a person, organisation, place, " +
              "project, product or system — whatever the facts concern. " +
              "Each has: name (as written); type (a short lowercase noun for what " +
              "it is — person, organisation, project, place, system, ...). " +
              SUBJECT_MARKING_CONTRACT + " " +
              "Respond with JSON only: {factId: [{name, type, relationship}, ...]}. " +
              "Omit facts with no entities. No prose.",
            `Extract entities from:\n${JSON.stringify(payload)}`,
          );
          const parsed = parseJson<Record<string, ExtractedEntity[]>>(raw);
          const map = new Map<string, ExtractedEntity[]>();
          for (const [id, entities] of Object.entries(parsed)) {
            if (Array.isArray(entities) && entities.length > 0) {
              map.set(id, entities);
            }
          }
          return map;
        },
        () => fallback.extractEntities(facts),
      );
    },

    async extractFactsFromEvents(events, workingMemory, sessionSummary, longTermMemory, extras) {
      if (events.length === 0) return { facts: [], degraded: false };
      return withFallback<ExtractionOutcome>(
        async () => {
          const raw = await ask(
            EXTRACT_DURABLE_JOB +
              " " +
              `${domainRoutingInstruction(extras?.vocabulary ?? vocabulary)} ` +
              `${entityTypeInstruction(extras?.entityTypes ?? [])} ` +
              EXTRACT_CONTEXT_CONTRACT + " " +
              "Respond with JSON only: {facts: [{content, domain_hint, valid_from, valid_until}], session_now?, referents?, topic_shifted?, confidence?}. " +
              `domain_hint is a domain already in use, a new short lowercase noun if none fits, or null. ` +
              "valid_from / valid_until are ISO dates or null. facts may be []. A JSON array of {content, domain_hint} is also accepted (facts only). No prose.",
            JSON.stringify({
              extract_today: extractTodayUtcDate(),
              session_now: extras?.now ?? null,
              referents: extras?.referents ?? [],
              topic_segments: extras?.segments ?? [],
              session_summary: sessionSummary ?? null,
              long_term_memory: (longTermMemory ?? []).map((f) => ({
                content: f.content,
                domain: f.domain,
              })),
              recent_events: workingMemory.map(extractEventPayload),
              reminder_events: (extras?.reminderEvents ?? []).map(extractEventPayload),
              candidate_events: events.map(extractEventPayload),
            }),
          );
          const parsed: unknown = parseJson(raw);
          const shaped = shapeExtractPayload(parsed);
          return {
            facts: shaped.facts.map((p) => ({
              content: p.content,
              domain_hint: p.domain_hint,
              valid_from: p.valid_from,
              valid_until: p.valid_until,
              source_quality: "sampling" as const,
            })),
            degraded: false,
            now: shaped.now,
            referents: shaped.referents,
            topic_shifted: shaped.topic_shifted,
            confidence: shaped.confidence,
          };
        },
        async () => {
          const fell = await fallback.extractFactsFromEvents(
            events,
            workingMemory,
            sessionSummary,
            longTermMemory,
            extras,
          );
          return { facts: fell.facts, degraded: true };
        },
      );
    },

    async detectSupersession(newFact, existingFacts) {
      if (existingFacts.length === 0) return null;
      // Filter to same-domain active candidates before sampling — cuts payload.
      const candidates = existingFacts.filter(
        (f) => f.domain === newFact.domain && f.status === "active" && f.is_latest,
      );
      if (candidates.length === 0) return null;
      return withFallback<SupersessionCandidate | null>(
        async () => {
          const payload = {
            new: { content: newFact.content, domain: newFact.domain },
            existing: candidates.map((f) => ({ id: f.id, content: f.content })),
          };
          const raw = await ask(
            "You detect whether a new fact supersedes (invalidates and replaces) an existing one. " +
              "Supersession applies when the new fact negates, updates, or replaces the older one " +
              "(e.g. 'I moved to Porto' supersedes 'I live in Lisbon'; " +
              "'I no longer drink coffee' supersedes 'I prefer coffee'). " +
              "Paraphrase or additional detail is NOT supersession. " +
              "Respond with JSON only: either {existingFactId: '...', reason: '...'} or null. No prose.",
            JSON.stringify(payload),
          );
          const parsed = parseJson<SupersessionCandidate | null>(raw);
          if (!parsed || !parsed.existingFactId) return null;
          // Guard against hallucinated IDs.
          const exists = candidates.some((f) => f.id === parsed.existingFactId);
          return exists ? parsed : null;
        },
        () => fallback.detectSupersession(newFact, existingFacts),
      );
    },

    async reconcile(candidate, existingFacts) {
      if (existingFacts.length === 0) return { kind: "add" };
      return withFallback<ReconcileDecision>(
        async () => {
          const payload = {
            candidate: { content: candidate.content },
            existing: existingFacts.map((f) => ({ id: f.id, content: f.content })),
          };
          const raw = await ask(
            "You decide whether a candidate fact is already covered by an existing fact. " +
              "'noop' means an existing fact captures the EXACT same information. " +
              "'enrich' means a paraphrase or corroboration of a specific existing fact — boost its confidence, don't duplicate. " +
              "'add' means the candidate adds something new. " +
              "Supersession (contradictions/updates) is handled separately — treat contradictions as 'add'. " +
              "Respond with JSON only: {decision: 'add'} | {decision: 'noop'} | {decision: 'enrich', existingFactId: '...'}. No prose.",
            JSON.stringify(payload),
          );
          const parsed = parseJson<
            | { decision: "add" }
            | { decision: "noop" }
            | { decision: "enrich"; existingFactId: string }
          >(raw);
          if (parsed.decision === "noop") return { kind: "noop" };
          if (parsed.decision === "enrich" && typeof parsed.existingFactId === "string") {
            const exists = existingFacts.some((f) => f.id === parsed.existingFactId);
            return exists
              ? { kind: "enrich", existingFactId: parsed.existingFactId }
              : { kind: "add" };
          }
          return { kind: "add" };
        },
        () => fallback.reconcile(candidate, existingFacts),
      );
    },

    async summarise(sessionFacts, graduatedFacts, priorSummary, closedTopics) {
      if (graduatedFacts.length === 0 && !priorSummary) {
        return { summary: "No facts graduated.", openThreads: [] };
      }
      return withFallback<SessionSummary>(
        async () => {
          const payload = {
            prior_summary: priorSummary ?? null,
            closed_topics: closedTopics ?? [],
            newly_graduated: graduatedFacts.map((f) => ({
              content: f.content,
              domain: f.domain,
            })),
          };
          const raw = await ask(
            "You maintain a rolling summary of an ongoing conversation. " +
              "Given prior_summary (the existing rolling summary, may be null), " +
              "closed_topics (activity gists closed this run, may be empty), and " +
              "newly_graduated (facts just consolidated this run), produce an UPDATED " +
              "rolling summary that integrates the new facts into the prior synopsis " +
              "and folds closed topics without destroying them as a topic log — " +
              "the segment list is stored separately. " +
              "Keep it to one cohesive paragraph; don't accumulate redundantly. " +
              "If prior_summary is null, write a fresh summary of newly_graduated alone. " +
              "Then list up to 5 open threads — questions or follow-ups the user might want revisited. " +
              "Respond with JSON only: {summary: string, openThreads: string[]}. No prose.",
            JSON.stringify(payload),
          );
          const parsed = parseJson<SessionSummary>(raw);
          return {
            summary: typeof parsed.summary === "string" ? parsed.summary : (priorSummary ?? ""),
            openThreads: Array.isArray(parsed.openThreads) ? parsed.openThreads : [],
          };
        },
        () => fallback.summarise(sessionFacts, graduatedFacts, priorSummary),
      );
    },
  };
}

