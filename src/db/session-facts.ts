/**
 * Data access for session facts and their provenance sources.
 * All functions are synchronous.
 */

import { randomUUID, createHash } from "node:crypto";
import { withTransaction } from "./connection.js";
import type { Db } from "./connection.js";
import type { SessionFact, SessionFactSource } from "../types/data.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface NewSessionFact {
  session_id: string;
  content: string;
  source_origin?: "explicit" | "inferred";
  source_event_id?: string | null;
  domain_hint?: string | null;
  subdomain_hint?: string | null;
  confidence?: number | null;
  importance?: number | null;
  /** LLM self-assessed signals — distinct from the explicit capture values.
   *  Providers like the CLI provider fill these when they have LLM judgements
   *  from extraction; consolidation can blend them with the explicit values. */
  confidence_signal?: number | null;
  importance_signal?: number | null;
  valid_from_hint?: string | null;
  valid_until_hint?: string | null;
  /** Pre-extracted entities carried through from holistic extraction.
   *  When present, consolidate() uses these directly instead of calling
   *  intelligence.extractEntities() again. */
  entities_json?: string | null;
  /** Provenance of this session fact's extraction quality. */
  source_quality?: "heuristic" | "cli" | "sampling" | "explicit";
  source_tool?: string | null;
  capture_context?: string | null;
  consolidation_id?: string | null;
}

export interface NewFactSource {
  session_fact_id: string;
  event_id: string;
  relevance?: number;
  extraction_type?: "primary" | "corroborating" | "contextual";
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Compute a SHA-256 hex digest of the given content string. */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Session Facts
// ---------------------------------------------------------------------------

/**
 * Insert a new session fact with intra-session dedup.
 * Returns the inserted SessionFact, or null if a duplicate already exists
 * (matched on session_id + content_hash).
 */
export function insertSessionFact(
  db: Db,
  fact: NewSessionFact,
): SessionFact | null {
  const id = randomUUID();
  const now = new Date().toISOString();
  const contentHash = computeContentHash(fact.content);
  const sourceOrigin = fact.source_origin ?? "explicit";
  const sourceEventId = fact.source_event_id ?? null;
  const domainHint = fact.domain_hint ?? null;
  const subdomainHint = fact.subdomain_hint ?? null;
  const confidence = fact.confidence ?? null;
  const importance = fact.importance ?? null;
  const confidenceSignal = fact.confidence_signal ?? null;
  const importanceSignal = fact.importance_signal ?? null;
  const validFromHint = fact.valid_from_hint ?? null;
  const validUntilHint = fact.valid_until_hint ?? null;
  const entitiesJson = fact.entities_json ?? null;
  const sourceQuality = fact.source_quality ?? "heuristic";
  const sourceTool = fact.source_tool ?? null;
  const captureContext = fact.capture_context ?? null;
  const consolidationId = fact.consolidation_id ?? null;

  return withTransaction(db, () => {
    const result = db.prepare(
      `INSERT OR IGNORE INTO session_facts
         (id, session_id, content, content_hash, source_origin, source_event_id,
          domain_hint, subdomain_hint, confidence, importance,
          confidence_signal, importance_signal,
          valid_from_hint, valid_until_hint, entities_json, source_quality,
          source_tool, capture_context,
          consolidation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      fact.session_id,
      fact.content,
      contentHash,
      sourceOrigin,
      sourceEventId,
      domainHint,
      subdomainHint,
      confidence,
      importance,
      confidenceSignal,
      importanceSignal,
      validFromHint,
      validUntilHint,
      entitiesJson,
      sourceQuality,
      sourceTool,
      captureContext,
      consolidationId,
      now,
    );

    if (result.changes === 0) {
      return null;
    }

    return {
      id,
      session_id: fact.session_id,
      content: fact.content,
      content_hash: contentHash,
      source_origin: sourceOrigin,
      source_event_id: sourceEventId,
      domain_hint: domainHint,
      subdomain_hint: subdomainHint,
      confidence,
      importance,
      confidence_signal: confidenceSignal,
      importance_signal: importanceSignal,
      valid_from_hint: validFromHint,
      valid_until_hint: validUntilHint,
      entities_json: entitiesJson,
      source_quality: sourceQuality,
      source_tool: sourceTool,
      capture_context: captureContext,
      consolidation_id: consolidationId,
      created_at: now,
    } satisfies SessionFact;
  });
}

/** Retrieve all facts for a session, ordered by creation time ascending. */
export function getSessionFacts(
  db: Db,
  sessionId: string,
): SessionFact[] {
  return db
    .prepare(
      `SELECT * FROM session_facts WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId) as unknown as SessionFact[];
}

/** Retrieve all session facts that have not yet been claimed by a consolidation run. */
export function getUnconsolidatedFacts(
  db: Db,
): SessionFact[] {
  return db
    .prepare(
      `SELECT * FROM session_facts WHERE consolidation_id IS NULL ORDER BY created_at ASC`,
    )
    .all() as unknown as SessionFact[];
}

/** Retrieve unconsolidated session facts for a specific session. */
export function getUnconsolidatedSessionFacts(
  db: Db,
  sessionId: string,
): SessionFact[] {
  return db
    .prepare(
      `SELECT * FROM session_facts
       WHERE session_id = ? AND consolidation_id IS NULL
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as unknown as SessionFact[];
}

/**
 * Atomically claim all unclaimed session facts for a consolidation run.
 * Caller must hold the consolidation lock — see consolidation-lock.ts.
 * Returns the number of facts claimed.
 */
export function claimForConsolidation(
  db: Db,
  consolidationId: string,
): number {
  const result = db.prepare(
    `UPDATE session_facts SET consolidation_id = ? WHERE consolidation_id IS NULL`,
  ).run(consolidationId);
  return Number(result.changes);
}

/** Retrieve all session facts claimed by a specific consolidation run. */
export function getClaimedFacts(
  db: Db,
  consolidationId: string,
): SessionFact[] {
  return db
    .prepare(
      `SELECT * FROM session_facts WHERE consolidation_id = ? ORDER BY created_at ASC`,
    )
    .all(consolidationId) as unknown as SessionFact[];
}

// ---------------------------------------------------------------------------
// Session Fact Sources
// ---------------------------------------------------------------------------

/**
 * Link a session event as a provenance source for a session fact.
 * Uses INSERT OR IGNORE so duplicate links are silently ignored.
 */
export function linkFactSource(
  db: Db,
  source: NewFactSource,
): void {
  const relevance = source.relevance ?? 1.0;
  const extractionType = source.extraction_type ?? "contextual";

  db.prepare(
    `INSERT OR IGNORE INTO session_fact_sources
       (session_fact_id, event_id, relevance, extraction_type)
     VALUES (?, ?, ?, ?)`,
  ).run(source.session_fact_id, source.event_id, relevance, extractionType);
}

/** Retrieve all provenance sources for a session fact. */
export function getFactSources(
  db: Db,
  sessionFactId: string,
): SessionFactSource[] {
  return db
    .prepare(
      `SELECT * FROM session_fact_sources WHERE session_fact_id = ?`,
    )
    .all(sessionFactId) as unknown as SessionFactSource[];
}

// ---------------------------------------------------------------------------
// Keyword search over unconsolidated facts
// ---------------------------------------------------------------------------

/**
 * Keyword-search facts that have been captured but not yet consolidated.
 *
 * These are knowledge the assistant was told and has not yet integrated. They
 * are deliberately kept apart from graduated facts rather than merged into the
 * same ranking: a session fact has been through none of the pipeline. It is not
 * deduplicated, not reconciled against existing knowledge, may contradict a fact
 * already held, and its domain_hint is a suggestion rather than a routing
 * decision. Presenting it as equal to graduated knowledge would overstate it.
 *
 * Not scoped to the current session. An unconsolidated fact from a session that
 * ended without consolidating is exactly the fact most at risk of being lost —
 * get_session_context cannot see it either, so this is its only route back.
 *
 * Keyword only: FTS5 is the sole signal that means anything before entities are
 * resolved and domains are routed.
 */
export function keywordSearchPending(
  db: Db,
  query: string,
  limit?: number,
): SessionFact[] {
  const effectiveLimit = limit ?? 20;

  const rows = db
    .prepare(
      `SELECT sf.*
       FROM session_facts_fts fts
       JOIN session_facts sf ON sf.rowid = fts.rowid
       WHERE session_facts_fts MATCH ?
         AND sf.consolidation_id IS NULL
       ORDER BY fts.rank
       LIMIT ?`,
    )
    .all(query, effectiveLimit) as unknown as SessionFact[];

  return rows;
}
