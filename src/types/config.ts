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
  /**
   * What belongs here, in one short clause. Shown to a classifier so it can
   * route accurately without guessing what a name means.
   */
  description?: string;
  /**
   * Keyword patterns for the fallback classifier, as regex source strings
   * (matched case-insensitively). Only used when no LLM is available.
   *
   * Config rather than code because a vocabulary is not universal. A personal
   * store routes on "allergic" and "partner"; a corporate one routes on
   * "incident" and "SLA"; a research one on "dataset" and "hypothesis". The
   * engine cannot know which, so it ships none and reads what it is given.
   *
   * Omit for a domain only an LLM should route to.
   */
  patterns?: string[];
  /**
   * Default importance for facts in this domain (0–1), when the assistant gives
   * no explicit value and no provider signals one.
   *
   * Also not universal: a missed allergy is the costliest error in a personal
   * store; a missed SLA breach is the costliest in a corporate one. Whoever owns
   * the vocabulary owns its calibration.
   */
  importance?: number;
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
export type IntelligenceProviderType = "heuristic" | "sampling" | "cli" | "api";

/** Knowledge capture configuration. */
export interface CaptureConfig {
  /** Default confidence when the AI doesn't specify (0.0–1.0). */
  default_confidence: number;
  // importance_defaults removed: importance is declared per-domain on DomainDef.
  // Two homes for one value is how they drift — and the capture-side lookup keyed
  // off a domain_hint that callers rarely pass and capture cannot know anyway,
  // because the classifier has not run yet.
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

/** Options for the 'cli' provider (subprocess `claude -p`). All optional —
 *  sensible defaults are applied by createCliProvider. */
export interface CliProviderConfig {
  /** Command + args to invoke the CLI. Default: resolves `claude` via PATH. */
  command?: string[];
  /** Model alias passed via --model. Default: "haiku". */
  model?: string;
  /** Per-stage subprocess timeout in ms. Default: 45000. */
  timeout_ms?: number;
  /** Emit provider debug logging to stderr. Default: false. */
  debug?: boolean;
}

/** Intelligence provider configuration. */
export interface IntelligenceConfig {
  /** Which provider to use for consolidation intelligence. */
  provider: IntelligenceProviderType;
  // No `fallback` field. The heuristic provider is the terminal fallback and is
  // not configurable on purpose: it is the only one that cannot itself fail,
  // needing neither a subprocess nor an MCP client. A configurable fallback
  // could name a provider with the same dependency that just failed, which is
  // the situation the fallback exists to survive.
  /** API key for the 'api' provider (when configured). */
  api_key: string | null;
  /** Options for the 'cli' provider. */
  cli?: CliProviderConfig;
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

/**
 * Retention policy for the raw event layer.
 *
 * Deliberately holds no schedule. The previous field here — days to keep
 * staging data — was read by nothing, which is worse than absent: a setting
 * that looks like a safeguard and is not stops anyone looking further.
 *
 * What replaced it is not a clock but `openmemory prune`, which removes events
 * nothing can reach — read by extraction, cited by no fact's provenance, and
 * outside the working-memory window. Age is the wrong instrument: an event's
 * value has nothing to do with how old it is, and a store that sits quiet for a
 * month should not lose events it has not extracted yet.
 *
 * Explicit rather than scheduled, because deletion is irreversible and this is
 * a memory product. If automatic pruning is ever added, it belongs here.
 */
export interface RetentionConfig {
  /**
   * Events per session spared as working memory when pruning. Null defers to
   * `extraction.working_memory_size`, which is the setting it protects — the
   * two must not drift, so there is normally no reason to set this.
   */
  prune_keep_per_session: number | null;
}

/** Which embedding backend produces vectors, if any. */
export type EmbeddingProviderType = "voyage" | "ollama";

/**
 * Semantic search configuration.
 *
 * Replaces a `search.embedding_provider` field that shipped for months with
 * nowhere to record a model, a dimension, or where the key lives — and with no
 * code reading it.
 *
 * `provider: null` is the default and means keyword-only search, exactly as
 * before. Nothing is shipped enabled, because shipping a default model would be
 * shipping an assumption about what "similar" means — the same mistake as
 * shipping a domain vocabulary, on a different axis.
 */
export interface EmbeddingConfig {
  /** null = semantic search off. Nothing downloads, nothing is called. */
  provider: EmbeddingProviderType | null;
  /** Provider default when null. Recorded on every vector it produces. */
  model: string | null;
  /**
   * Truncate vectors to this many dimensions, on models that support it.
   *
   * The scaling lever, not a storage micro-optimisation: the scan reads every
   * vector on every query, so dimension decides how many facts fit in page
   * cache. null keeps the model's native size.
   */
  dimensions: number | null;
  /**
   * Environment variable holding the API key. The key itself is never stored
   * in config.json — a config file that holds secrets is a config file that
   * gets committed.
   */
  api_key_env: string;
  /** Facts per embedding call during consolidation. */
  batch_size: number;
  /**
   * How close to the best match a semantic result must be to count as one,
   * as a ratio of the best score. Default 0.85.
   *
   * Cosine similarity has no natural zero: every stored vector scores against
   * every query, and unrelated facts land near the model's floor rather than
   * near 0. Some cut is therefore unavoidable, or semantic search returns the
   * whole store for every query.
   *
   * Tunable because **the floor is a property of the model, not of relevance**.
   * The default was measured against `nomic-embed-text`, where unrelated facts
   * sit around 0.45; a model with a tighter or wider spread wants a different
   * ratio. This is the same reason `dimensions` is configurable rather than
   * fixed.
   *
   * Lower keeps more and recalls more loosely; higher keeps fewer and demands
   * closer matches. The extremes are meaningful rather than invalid: 0 keeps
   * everything and leaves the ranking entirely to the merge, 1 keeps only
   * results tied with the best. Values outside 0–1 are clamped.
   */
  min_similarity_ratio: number;
  /**
   * Absolute cosine floor for a semantic hit. Null (the default) defers to the
   * provider's own measured value; `0` disables the floor entirely.
   *
   * `min_similarity_ratio` asks whether a result is comparable to the best
   * result. It cannot ask whether the best result is any good — so a query the
   * store knows nothing about produces a tight cluster of noise in which every
   * ratio passes, and the whole store comes back. This is the cut that answers
   * it, and it is off by default because the right value is a property of the
   * embedding model rather than of relevance — which is why the number lives
   * on the provider and this field only overrides it. Measure your own by
   * embedding a query your store genuinely cannot answer and reading the top
   * score: anything at or below it is noise.
   */
  min_similarity: number | null;
  /** Ollama only. */
  host?: string;
}

/**
 * A named capture source for this store.
 *
 * Empty `sources` (the default) means pull is off: nothing is discovered, and
 * MCP `log_event` / `capture_fact` keep working as they do today. A source is
 * explicit — `{ kind, home, cwd? }` — and scoped to this store. OpenMemory
 * does not auto-glob `~/.claude*` or honour `CLAUDE_CONFIG_DIR` as implicit
 * discovery; that variable is only useful as an example of what `home` is
 * (the Claude Code config dir).
 *
 * This slice understands `kind: "claude-code"` only. Other clients (Grok,
 * Codex, Cursor) are later adapters.
 */
export type CaptureSourceKind = "claude-code";

export interface CaptureSource {
  /** Adapter to run. Only `"claude-code"` is implemented in this version. */
  kind: CaptureSourceKind;
  /**
   * Claude Code config dir — the directory `CLAUDE_CONFIG_DIR` would point
   * at, e.g. `~/.claude` or `C:\\Users\\gordo\\.claude-investment`.
   * Transcripts are read from `home/projects/<encoded-cwd>/` only.
   */
  home: string;
  /**
   * Strongly recommended. Restricts ingest to that project's transcript
   * group (`C:\\dev\\investment` encodes as `C--dev-investment`). A bare
   * `home` walks every project group under `projects/` — a first pull of a
   * shared Claude home can be thousands of files.
   */
  cwd?: string;
}

/** Top-level server configuration (loaded from config.json in data dir). */
export interface ServerConfig {
  storage: {
    provider: "sqlite";
    sqlite?: { path: string };
  };
  temporal: TemporalConfig;
  embedding: EmbeddingConfig;

  capture: CaptureConfig;
  extraction: ExtractionConfig;
  intelligence: IntelligenceConfig;
  consolidation: ConsolidationConfig;
  retention: RetentionConfig;

  /**
   * Named capture sources to pull into `session_events`. Default `[]` — pull
   * is off until the user names a source. Replaced (not merged) like every
   * other config array: a user-supplied list is the whole list.
   */
  sources: CaptureSource[];

  /** Optional seed domains with suggested subdomains, created on init.
   *  New domains can also be created at runtime by the calling LLM or server.
   *  If omitted, the server starts with an empty domains table. */
  domains?: DomainDef[];
}

/** Default configuration values. */
export const DEFAULT_CONFIG: Omit<ServerConfig, "storage" | "temporal"> = {
  embedding: {
    provider: null,
    model: null,
    dimensions: null,
    api_key_env: "VOYAGE_API_KEY",
    batch_size: 128,
    min_similarity_ratio: 0.85,
    min_similarity: null,
  },
  capture: {
    default_confidence: DEFAULT_CONFIDENCE,
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
    // Default to the CLI provider — spawns the `claude` CLI using the user's
    // existing subscription for real LLM consolidation, with no API key. Many
    // MCP clients don't advertise the sampling capability, so the sampling
    // provider would degrade to regex for them; the CLI provider is the path
    // that actually delivers server-side intelligence on those hosts. Every
    // stage falls back to the heuristic provider on failure (CLI not installed,
    // rate limit, timeout). Override with the OPENMEMORY_PROVIDER env var
    // (e.g. =heuristic) or intelligence.provider in config.json.
    provider: "cli",
    api_key: null,
  },
  consolidation: {
    triggers: ["session_start", "threshold", "compaction", "shutdown", "manual"],
    threshold: 10,
    auto_link_events: 5,
  },
  retention: {
    prune_keep_per_session: null,
  },
  sources: [],
};
