/**
 * Data model types — the shape of records stored and returned by OpenMemory.
 *
 * DIKW here is an engineering abstraction (Ackoff 1989), not a memory-science model.
 * Organised by the DIKW hierarchy:
 *
 *   Data         SessionEvent    Raw interactions, uninterpreted, append-only
 *   Information  SessionFact     LLM-extracted, tagged, awaiting integration
 *   Knowledge    Fact            Graduated, entity-linked, deduplicated, routed
 *   Wisdom       Inference       Applied judgement — hypotheses from patterns (not yet implemented)
 *
 * Each transformation is explicit:
 *   Data → Information    The calling LLM captures explicitly (capture_fact) or the server
 *                          extracts from events during consolidation (hybrid capture model)
 *   Information → Knowledge   Event-driven batch consolidation
 *   Knowledge → Wisdom        Inference pipeline (not yet implemented)
 *
 * Session scopes the technical boundary (MCP connection).
 * Episodes (narrative boundaries) are discovered at consolidation, not declared here.
 */

/** MCP connection lifecycle — an open-ended container for events and facts. */
export interface Session {
  id: string;
  source_tool: string | null;
  project: string | null;
  started_at: string;
  last_activity_at: string;
}

/** A consolidation run over session facts. Can happen multiple times per session. */
export interface Consolidation {
  id: string;
  session_id: string | null;
  facts_in: number;
  facts_graduated: number;
  facts_rejected: number;
  entities_created: number;
  entities_linked: number;
  supersessions: number;
  summary: string | null;
  open_threads: string[] | null;
  created_at: string;
}

/**
 * DIKW: Data — raw interaction event. Append-only, never server-purged.
 * The episodic ground truth. Events are grouped into episodes at consolidation.
 */
export interface SessionEvent {
  id: string;
  /** Openmemory MCP server's connection UUID. Null for hook-sourced events. */
  mcp_session_id: string | null;
  /** AI client's conversation UUID. Null when unknown. */
  client_session_id: string | null;
  sequence: number;
  event_type: "message" | "tool_call" | "tool_result" | "artifact";
  role: "user" | "assistant" | "system" | "tool";
  content_type: "text" | "json" | "image" | "audio" | "binary";
  content: string | null;
  /** URI or path for non-text content. Reference, not embed. */
  content_ref: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * DIKW: Information — captured or extracted fact awaiting consolidation.
 * Also serves as in-session working memory (queryable via get_session_context).
 * Graduates to Fact during consolidation.
 */
export interface SessionFact {
  id: string;
  session_id: string;
  content: string;
  /** SHA-256 of content for intra-session dedup. */
  content_hash: string;
  /** Who created this: AI via capture_fact ('explicit') or server via event extraction ('inferred'). */
  source_origin: "explicit" | "inferred";
  /** Points to the primary SessionEvent that prompted this capture. */
  source_event_id: string | null;
  domain_hint: string | null;
  confidence: number | null;
  importance: number | null;
  source_tool: string | null;
  capture_context: string | null;
  /** UUID of the consolidation run that claimed this fact (null = unclaimed). */
  consolidation_id: string | null;
  created_at: string;
}

/** Provenance link: which events contributed to a session fact. */
export interface SessionFactSource {
  session_fact_id: string;
  event_id: string;
  /** How central this event was to the extracted fact (0.0–1.0). */
  relevance: number;
  /** 'primary' = stated the fact, 'corroborating' = mentioned again, 'contextual' = nearby context. */
  extraction_type: "primary" | "corroborating" | "contextual";
}

/**
 * DIKW: Knowledge — graduated fact in the canonical store. Entity-linked,
 * deduplicated, domain-routed. Only enters this table after consolidation.
 */
export interface Fact {
  id: string;
  content: string;
  domain: string;
  subdomain: string | null;
  confidence: number;
  importance: number;
  source_type: string;
  source_tool: string | null;
  source_id: string | null;
  status: "active" | "superseded" | "rejected";
  superseded_by: string | null;
  is_latest: boolean;
  created_at: string;
  valid_from: string | null;
  valid_until: string | null;
  system_retired_at: string | null;
  session_id: string | null;
  capture_context: string | null;
  access_count: number;
}

export interface Entity {
  id: string;
  type: string;
  name: string;
  canonical_name: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  access_count: number;
  last_accessed_at: string | null;
}

export interface EntityEdge {
  from_entity: string;
  to_entity: string;
  relationship: string;
  strength: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  last_accessed_at: string | null;
}

export interface Source {
  id: string;
  type: string;
  tool_id: string | null;
  timestamp: string;
  raw_content: string | null;
  metadata: Record<string, unknown> | null;
}

/** DIKW: Wisdom — applied judgement. Hypotheses derived from patterns across facts (not yet implemented). */
export interface Inference {
  id: string;
  hypothesis: string;
  evidence: string[];
  confidence: number;
  status: "pending" | "confirmed" | "rejected";
  rejection_reason: string | null;
  no_reinfer_until: string | null;
  created_at: string;
  validated_at: string | null;
}

export interface SearchResult {
  fact: Fact;
  score: number;
  entities: Entity[];
  source: Source | null;
}

/** Search response with retrieval quality signals for calling AIs. */
export interface SearchResponse {
  results: SearchResult[];
  /** Estimated fraction of relevant knowledge surfaced (0.0–1.0). */
  coverage_estimate: number;
  /** Confidence in result quality based on score distribution (0.0–1.0). */
  result_confidence: number;
  /** Suggested query refinement when results look thin. */
  suggested_refinement: string | null;
}
