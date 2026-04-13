/**
 * Intelligence provider interface for the consolidation pipeline.
 * All methods are async from day one — heuristic resolves synchronously,
 * but sampling/API providers will need async.
 */

import type { SessionFact, SessionEvent, Fact } from "../types/data.js";

/** A fact with domain classification applied. */
export interface ClassifiedFact {
  /** Original SessionFact ID. */
  id: string;
  content: string;
  domain: string;
  subdomain: string | null;
}

/** An entity extracted from a fact. */
export interface ExtractedEntity {
  name: string;
  type: string;
  relationship: string;
}

/** A candidate for superseding an existing fact. */
export interface SupersessionCandidate {
  existingFactId: string;
  reason: string;
}

/** Result of reconciling a candidate against existing knowledge.
 *  'add' = genuinely new, 'noop' = duplicate.
 *  Supersession is a separate mechanism — not a reconcile decision. */
export type ReconcileDecision = "add" | "noop";

/** Session summary produced during consolidation. */
export interface SessionSummary {
  summary: string;
  openThreads: string[];
}

/**
 * Intelligence provider — pluggable backend for consolidation intelligence.
 * Implementations: heuristic (keyword/regex), sampling (MCP client LLM), api (direct LLM call).
 */
export interface IntelligenceProvider {
  /** Classify facts into domains/subdomains.
   *  sessionContext is optional — reserved for future providers that need
   *  a conversation summary (LLM-based providers). The heuristic provider ignores it. */
  classifyFacts(
    facts: SessionFact[],
    sessionContext?: string,
  ): Promise<ClassifiedFact[]>;

  /** Extract entities from facts holistically across the batch. */
  extractEntities(
    facts: SessionFact[],
  ): Promise<Map<string, ExtractedEntity[]>>;

  /** Extract facts from raw session events (D→I transition). */
  extractFactsFromEvents(
    events: SessionEvent[],
    contextEvents: SessionEvent[],
  ): Promise<Array<{ content: string; domain_hint: string | null }>>;

  /** Detect if a new fact supersedes an existing one. */
  detectSupersession(
    newFact: ClassifiedFact,
    existingFacts: Fact[],
  ): Promise<SupersessionCandidate | null>;

  /** Reconcile candidate against existing knowledge: 'add' if new, 'noop' if
   *  duplicate. Supersession is a separate mechanism via detectSupersession. */
  reconcile(
    candidate: SessionFact,
    existingFacts: Fact[],
  ): Promise<ReconcileDecision>;

  /** Generate a session summary from the consolidated batch. */
  summarise(
    facts: SessionFact[],
    graduatedFacts: Fact[],
  ): Promise<SessionSummary>;
}
