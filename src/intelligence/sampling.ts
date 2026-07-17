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
  ExtractedFact,
  SupersessionCandidate,
  ReconcileDecision,
  SessionSummary,
} from "./types.js";
import type { SessionEvent } from "../types/data.js";
import { createHeuristicProvider } from "./heuristic.js";
import { domainRoutingInstruction } from "../schemas/domains.js";
import type { DomainDef } from "../types/config.js";

// Conservative token budgets. Prompts are short; responses are JSON-only.
const DEFAULT_MAX_TOKENS = 2048;

/** Extract text from a createMessage result, or throw if shape is unexpected. */
function readText(result: { content: { type: string; text?: string } }): string {
  if (result.content.type !== "text" || typeof result.content.text !== "string") {
    throw new Error(`Expected text content, got ${result.content.type}`);
  }
  return result.content.text;
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
            "You extract entities (people, places, organisations) from facts. " +
              "For each fact, list the entities mentioned. " +
              "Each entity has: name (as written), type (person|place|org), " +
              "relationship (how the entity relates to the user, e.g. 'partner_of', " +
              "'friend_of', 'employer', 'mentioned'). " +
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

    async extractFactsFromEvents(events, workingMemory, sessionSummary, longTermMemory) {
      if (events.length === 0) return [];
      return withFallback<ExtractedFact[]>(
        async () => {
          const trim = (e: SessionEvent) => ({
            role: e.role,
            content: e.content,
          });
          const raw = await ask(
            "You extract durable facts about the user from a conversation. " +
              "A fact is something the user wants remembered for future conversations: " +
              "preferences, personal details, medical information, relationships, " +
              "work context, opinions, decisions. " +
              "Ignore ephemeral statements (current tasks, transient mood). " +
              "Each fact should be a complete, self-contained sentence — rewrite as needed. " +
              "session_summary is a rolling synopsis of this conversation up to recent_events; " +
              "use it for long-range context but DO NOT re-extract facts already covered. " +
              "recent_events provides immediate conversational context for pronoun resolution; " +
              "DO NOT extract facts from recent_events — only from candidate_events. " +
              "long_term_memory holds already-known facts about the user across all sessions; " +
              "use it to avoid duplicating facts the system already has. " +
              "Respond with JSON only: an array of {content, domain_hint} objects. " +
              `domain_hint is a domain already in use, a new short lowercase noun if none fits, or null. ` +
              "Return [] if no durable facts are present. No prose.",
            JSON.stringify({
              session_summary: sessionSummary ?? null,
              long_term_memory: (longTermMemory ?? []).map((f) => ({
                content: f.content,
                domain: f.domain,
              })),
              recent_events: workingMemory.map(trim),
              candidate_events: events.map(trim),
            }),
          );
          const parsed = parseJson<Array<{ content: string; domain_hint: string | null }>>(raw);
          if (!Array.isArray(parsed)) return [];
          return parsed.map((p) => ({
            content: p.content,
            domain_hint: p.domain_hint,
            source_quality: "sampling" as const,
          }));
        },
        () => fallback.extractFactsFromEvents(events, workingMemory, sessionSummary, longTermMemory),
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

    async summarise(sessionFacts, graduatedFacts, priorSummary) {
      if (graduatedFacts.length === 0 && !priorSummary) {
        return { summary: "No facts graduated.", openThreads: [] };
      }
      return withFallback<SessionSummary>(
        async () => {
          const payload = {
            prior_summary: priorSummary ?? null,
            newly_graduated: graduatedFacts.map((f) => ({
              content: f.content,
              domain: f.domain,
            })),
          };
          const raw = await ask(
            "You maintain a rolling summary of an ongoing conversation. " +
              "Given prior_summary (the existing rolling summary, may be null) and " +
              "newly_graduated (facts just consolidated this run), produce an UPDATED " +
              "rolling summary that integrates the new facts into the prior synopsis. " +
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

