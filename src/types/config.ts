/**
 * Server configuration types — how OpenMemory is initialised and configured.
 */

/** Default importance when not specified by the calling LLM or user config. */
export const DEFAULT_IMPORTANCE = 0.5;

/** Default confidence when not specified by the calling LLM. */
export const DEFAULT_CONFIDENCE = 0.7;

/** A domain definition — seed domains ship in config, new ones created at runtime. */
export interface DomainDef {
  name: string;
  subdomains: string[];
}

/** Temporal mode configuration. */
export type TemporalMode = "simple" | "bitemporal";

export interface TemporalConfig {
  mode: TemporalMode;
  /** ISO timestamp recorded automatically when switching from simple to bitemporal.
   *  System-time queries before this date return incomplete results. */
  bitemporal_since: string | null;
}

/** Intelligence provider type. */
export type IntelligenceProviderType = "heuristic" | "sampling" | "api";

/** Knowledge capture configuration. */
export interface CaptureConfig {
  /** Default confidence when the AI doesn't specify (0.0–1.0). */
  default_confidence: number;
  /** Domain-level importance defaults. Falls back to DEFAULT_IMPORTANCE. */
  importance_defaults: Record<string, number>;
}

/** Event extraction configuration (D→I during consolidation). */
export interface ExtractionConfig {
  /** Whether to scan raw events for facts during consolidation.
   *  Defaults to true — the in-process scheduler relies on this to graduate
   *  session_events into facts without requiring the AI client to call
   *  capture_fact. Set to false to make consolidation rely solely on explicit
   *  capture. */
  enabled: boolean;
  /** Which event types to process. */
  event_types: string[];
  /** Which roles to process. */
  roles: string[];
  /** Max events per LLM extraction call. */
  batch_size: number;
  /** Skip events shorter than this (chars). */
  min_content_length: number;
  /** Truncate events longer than this for extraction (full content preserved). */
  max_content_length: number;
  /** Max number of pre-watermark events from the same session to pass to the
   *  extraction provider as working memory. Larger values give the LLM richer
   *  pronoun resolution and topical continuity at the cost of more tokens per
   *  call. The 0 case effectively disables working memory. */
  working_memory_size: number;
}

/** Intelligence provider configuration. */
export interface IntelligenceConfig {
  /** Which provider to use for consolidation intelligence. */
  provider: IntelligenceProviderType;
  /** Fallback provider when primary is unavailable. */
  fallback: IntelligenceProviderType | null;
  /** API key for the 'api' provider (when configured). */
  api_key: string | null;
}

/** Consolidation trigger configuration. */
export interface ConsolidationConfig {
  /** Which triggers are active. */
  triggers: string[];
  /** Auto-consolidate after this many session_facts accumulate. */
  threshold: number;
  /** Number of recent events to auto-link as contextual sources on capture_fact. */
  auto_link_events: number;
}

/** Retention policy for staging data. */
export interface RetentionConfig {
  /** Days to keep session_facts after graduation. Null = forever. */
  session_facts_days: number | null;
}

/** Top-level server configuration (loaded from config.json in data dir). */
export interface ServerConfig {
  storage: {
    provider: "sqlite";
    sqlite?: { path: string };
  };
  temporal: TemporalConfig;
  search?: {
    embedding_provider: "openai" | "ollama" | null;
  };

  capture: CaptureConfig;
  extraction: ExtractionConfig;
  intelligence: IntelligenceConfig;
  consolidation: ConsolidationConfig;
  retention: RetentionConfig;

  /** Optional seed domains with suggested subdomains, created on init.
   *  New domains can also be created at runtime by the calling LLM or server.
   *  If omitted, the server starts with an empty domains table. */
  domains?: DomainDef[];
}

/** Default configuration values. */
export const DEFAULT_CONFIG: Omit<ServerConfig, "storage" | "temporal"> = {
  capture: {
    default_confidence: DEFAULT_CONFIDENCE,
    importance_defaults: {},
  },
  extraction: {
    enabled: true,
    event_types: ["message", "tool_call", "tool_result", "artifact"],
    roles: ["user", "assistant", "system", "tool"],
    batch_size: 50,
    min_content_length: 10,
    max_content_length: 2000,
    working_memory_size: 50,
  },
  intelligence: {
    // Default to the sampling provider — uses the MCP client's sampling
    // capability for LLM intelligence. Falls through to the heuristic provider
    // per-method when the client doesn't advertise sampling support.
    provider: "sampling",
    fallback: "heuristic",
    api_key: null,
  },
  consolidation: {
    triggers: ["session_start", "threshold", "compaction", "shutdown", "manual"],
    threshold: 10,
    auto_link_events: 5,
  },
  retention: {
    session_facts_days: 30,
  },
};
