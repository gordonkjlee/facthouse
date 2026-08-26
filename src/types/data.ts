/**
 * Data model types — the shape of records stored and returned by OpenMemory.
 *
 * DIKW here is an engineering abstraction (Ackoff 1989), not a memory-science model.
 * Organised by the DIKW hierarchy:
 *
 *   Data         SessionEvent    Raw interactions, uninterpreted, append-only
 *   Information  SessionFact     LLM-extracted, tagged, awaiting integration
 *   Knowledge    Fact            Graduated, entity-linked, deduplicated, routed
 *   Wisdom       Inference       Gated hypotheses. Default off. Not produced by I→K.
 *
 * Each transformation is explicit:
 *   Data → Information    Pull / log-event fill session_events; capture_fact is
 *                          an optional explicit correction; extraction runs at
 *                          consolidation
 *   Information → Knowledge   Event-driven batch consolidation
 *   Knowledge → Wisdom        capture_inference then validate_inference (opt-in)
 *
 * Session scopes the MCP connection. Conversation identity is written at
 * insert (`client_session_id`, else `mcp_session_id`). Consolidation extracts
 * each conversation separately; it does not invent narrative boundaries.
 */

/** MCP connection lifecycle — an open-ended container for events and facts. */
export interface Session {
  id: string;
  source_tool: string | null;
  project: string | null;
  started_at: string;
  last_activity_at: string;
}

/** Last-known binding for a live deictic in the current activity. */
export interface Referent {
  phrase: string;
  binding: string;
}

/**
 * A closed activity in one conversation: gist + referents as they were,
 * bounded by event sequence. Return-worthy, not a per-noun granule.
 */
export interface TopicSegment {
  start_sequence: number;
  end_sequence: number;
  gist: string;
  referents: Referent[];
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
  /** Current activity gist for this session_id, if this row carries situation. */
  now: string | null;
  now_start_sequence: number | null;
  now_referents: Referent[] | null;
  segments: TopicSegment[] | null;
  created_at: string;
}

/** Who uttered a session event — channel, not a named participant. */
export type SpeakerRole = "user" | "assistant" | "system" | "tool";

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
  role: SpeakerRole;
  content_type: "text" | "json" | "image" | "audio" | "binary";
  content: string | null;
  /** URI or path for non-text content. Reference, not embed. */
  content_ref: string | null;
  metadata: Record<string, unknown> | null;
  /** When OpenMemory wrote this row. */
  created_at: string;
  /**
   * When the turn was said. Pull copies Claude Code JSONL `timestamp` when
   * present, otherwise null (a backfill must not pretend ingest was speech).
   * Hook `log-event` and MCP `log_event` stamp the call — those fire at the
   * turn, and the hook payload has no clock of its own.
   */
  occurred_at: string | null;
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
  /** LLM-suggested subdomain tag (e.g. 'beverage', 'dietary'). */
  subdomain_hint: string | null;
  confidence: number | null;
  importance: number | null;
  /** LLM self-assessed confidence 0–1. */
  confidence_signal: number | null;
  /** LLM-assessed importance/durability 0–1. */
  importance_signal: number | null;
  /** ISO timestamp when this fact became true, if the LLM extracted it. */
  valid_from_hint: string | null;
  /** ISO timestamp when this fact stopped being true, if the LLM extracted it. */
  valid_until_hint: string | null;
  /** JSON-serialised entities attached to this fact by holistic extraction. */
  entities_json: string | null;
  /** Which provider produced this fact. */
  source_quality: "heuristic" | "cli" | "sampling" | "explicit";
  source_tool: string | null;
  capture_context: string | null;
  /** UUID of the consolidation run that claimed this fact (null = unclaimed). */
  consolidation_id: string | null;
  /**
   * Role of the primary event this fact was extracted from. Null when there
   * is no primary (rewritten sentences that do not appear in any event, or
   * explicit capture with no source event). Not who the fact is about.
   */
  speaker_role: SpeakerRole | null;
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
  /** Which intelligence provider produced this fact. Enables provenance
   *  tracking and future reprocess passes that upgrade heuristic-era facts. */
  source_quality: "heuristic" | "cli" | "sampling" | "explicit";
  /**
   * Role of the primary event, copied from session_facts at graduation.
   * Null when unknown. Distinct from source_origin (how it entered I) and
   * source_type (conversation vs inference).
   */
  speaker_role: SpeakerRole | null;
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
  /**
   * This entity is the user of this store. At most one row may set it.
   *
   * Stored as 0/1 rather than a boolean because SQLite has no boolean type and
   * the partial unique index that enforces the singleton indexes the raw value.
   */
  is_self: 0 | 1;
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

/**
 * A fact retrieved via an entity, carrying how it relates to that entity.
 *
 * `is_subject` distinguishes "this fact is about Robin" from "this fact happens
 * to name Robin" — the difference between what is known about someone and where
 * they have been mentioned. Surfaced to callers rather than kept internal
 * because an assistant reading these needs it too: a fact naming Robin as an
 * approver should not be repeated back as a fact about Robin.
 */
export type EntityFact = Fact & { is_subject: boolean };

/**
 * A hypothesis awaiting (or after) a validation gate. Not knowledge until
 * confirmed. Wisdom-layer judgement, gated: I→K never writes these.
 */
export type InferenceStatus = "pending" | "confirmed" | "rejected";

export interface Inference {
  id: string;
  hypothesis: string;
  status: InferenceStatus;
  /** Fact ids cited as support. Required at capture; never empty. */
  evidence_fact_ids: string[];
  reason: string | null;
  /** Graduated fact id, set only when confirmed. */
  fact_id: string | null;
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
/**
 * A fact captured but not yet consolidated — knowledge the assistant was told
 * and has not yet integrated.
 *
 * Kept apart from `results` rather than merged into the same ranking, because a
 * pending fact has been through none of the pipeline: not deduplicated, not
 * reconciled against existing knowledge, possibly contradicting a fact already
 * held, with a domain that is still only a hint. It is real knowledge and must
 * be findable — but presenting it as equal to a graduated fact would overstate
 * what is actually known.
 */
export interface PendingFact {
  id: string;
  content: string;
  /** Where it came from: the assistant via capture_fact, or event extraction. */
  source_origin: "explicit" | "inferred";
  /** Suggested domain, not a routing decision — consolidation may disagree. */
  domain_hint: string | null;
  /**
   * The caller's stated confidence, or the configured default applied at
   * capture. Nullable because the column is — nothing guarantees a value until
   * consolidation scores it properly. Treat it as the assistant's own estimate,
   * not a corroborated score: nothing has yet checked it against what is
   * already known.
   */
  confidence: number | null;
  created_at: string;
  session_id: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /**
   * Matching facts captured this session or a previous one that have not been
   * consolidated yet. Keyword-matched only — entities and domains do not exist
   * for a fact until it graduates.
   */
  pending: PendingFact[];
  /**
   * Short raw-log windows around a keyword hit in `session_events`. Filled
   * only when graduated `results` are empty — pattern completion from D, not
   * a second retrieval product. Not extracted, not reconciled; never mixed
   * into `results` or `pending`.
   */
  episodes: EpisodeSlice[];
  /** Estimated fraction of relevant knowledge surfaced (0.0–1.0). */
  coverage_estimate: number;
  /** Confidence in result quality based on score distribution (0.0–1.0). */
  result_confidence: number;
  /** Suggested query refinement when results look thin. */
  suggested_refinement: string | null;
  /**
   * Set when searching as-of system time and the requested instant is before
   * this store started recording `system_retired_at`. Supersessions from the
   * simple-mode era left that column null, so a fact the system had already
   * replaced can still appear as believed at T.
   */
  system_time_warning?: string | null;
}

/** One event inside an episode slice. */
export interface EpisodeEvent {
  id: string;
  sequence: number;
  role: SessionEvent["role"];
  event_type: SessionEvent["event_type"];
  content: string | null;
  /** True on the event whose content matched the query. */
  matched: boolean;
}

/**
 * A short window of `session_events` around a keyword hit.
 *
 * `conversation_id` is the client chat id, else the MCP session id, else the
 * hit event's id (same partition as prune).
 */
export interface EpisodeSlice {
  conversation_id: string;
  events: EpisodeEvent[];
}
