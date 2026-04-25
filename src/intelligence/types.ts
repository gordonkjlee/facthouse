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
  /** If the LLM resolved this mention to an existing entity (by id in the
   *  candidate set passed to the provider), that id is here. Absence means
   *  create a new entity. */
  existing_id?: string;
}

/** Rich per-fact output from holistic D→I extraction. */
export interface ExtractedFact {
  content: string;
  domain_hint: string | null;
  /** Short subdomain tag (e.g. "beverage", "dietary"). */
  subdomain_hint?: string | null;
  /** LLM self-assessed confidence 0–1 for this extraction. */
  confidence_signal?: number | null;
  /** LLM-assessed durability/importance 0–1. */
  importance_signal?: number | null;
  /** Short description of what the conversation was about when this was stated. */
  capture_context?: string | null;
  /** ISO timestamp when the fact became true, if stated. */
  valid_from?: string | null;
  /** ISO timestamp when the fact stopped being true, if stated. */
  valid_until?: string | null;
  /** Entities mentioned in this fact, pre-resolved against existing candidates. */
  entities?: ExtractedEntity[];
  /** Which provider produced this extraction. Consolidate uses this to
   *  propagate source_quality through to graduated facts. */
  source_quality?: "heuristic" | "cli" | "sampling";
}

/** A candidate for superseding an existing fact. */
export interface SupersessionCandidate {
  existingFactId: string;
  reason: string;
}

/** Result of reconciling a candidate against existing knowledge.
 *  'add' = genuinely new, 'noop' = duplicate, 'enrich' = paraphrase/corroboration
 *  of an existing fact (boost the existing fact's confidence instead of creating).
 *  Supersession is a separate mechanism — not a reconcile decision. */
export type ReconcileDecision =
  | { kind: "add" }
  | { kind: "noop" }
  | { kind: "enrich"; existingFactId: string };

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
  /** Extract durable facts from events since the last consolidation.
   *  @param events           Session events with sequence > last watermark
   *                          — candidates for extraction.
   *  @param workingMemory    Pre-watermark events from the SAME session as
   *                          the candidates. Recent conversational context
   *                          for pronoun resolution and topical flow.
   *                          NOT re-extracted. Capped at
   *                          extraction.working_memory_size.
   *  @param sessionSummary   Rolling summary of the entire current session
   *                          up to the last consolidation (optional). Provides
   *                          long-range conversational memory beyond the
   *                          working_memory_size window.
   *  @param longTermMemory   Currently-active graduated facts (optional).
   *                          Cross-session background knowledge. */
  extractFactsFromEvents(
    events: SessionEvent[],
    workingMemory: SessionEvent[],
    sessionSummary?: string | null,
    longTermMemory?: Fact[],
  ): Promise<ExtractedFact[]>;

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

  /** Generate the rolling session summary. The returned `summary` is the
   *  CUMULATIVE summary of the session as of this consolidation — combining
   *  any prior summary with what was just graduated. Stored on the
   *  consolidations row; the latest row's summary acts as long-range working
   *  memory for the next consolidation in the same session.
   *  @param priorSummary  Rolling summary from the latest prior consolidation
   *                       in this session, if any. Null/undefined for the
   *                       first consolidation in a session. */
  summarise(
    facts: SessionFact[],
    graduatedFacts: Fact[],
    priorSummary?: string | null,
  ): Promise<SessionSummary>;
}
