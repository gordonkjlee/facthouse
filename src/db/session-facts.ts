/**
 * Data access for session facts and their provenance sources.
 * All functions are synchronous (better-sqlite3).
 */

import { randomUUID, createHash } from "node:crypto";
import type Database from "better-sqlite3";
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
  confidence?: number | null;
  importance?: number | null;
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
  db: Database.Database,
  fact: NewSessionFact,
): SessionFact | null {
  const id = randomUUID();
  const now = new Date().toISOString();
  const contentHash = computeContentHash(fact.content);
  const sourceOrigin = fact.source_origin ?? "explicit";
  const sourceEventId = fact.source_event_id ?? null;
  const domainHint = fact.domain_hint ?? null;
  const confidence = fact.confidence ?? null;
  const importance = fact.importance ?? null;
  const sourceTool = fact.source_tool ?? null;
  const captureContext = fact.capture_context ?? null;
  const consolidationId = fact.consolidation_id ?? null;

  return db.transaction(() => {
    const result = db.prepare(
      `INSERT OR IGNORE INTO session_facts
         (id, session_id, content, content_hash, source_origin, source_event_id,
          domain_hint, confidence, importance, source_tool, capture_context,
          consolidation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      fact.session_id,
      fact.content,
      contentHash,
      sourceOrigin,
      sourceEventId,
      domainHint,
      confidence,
      importance,
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
      confidence,
      importance,
      source_tool: sourceTool,
      capture_context: captureContext,
      consolidation_id: consolidationId,
      created_at: now,
    } satisfies SessionFact;
  })();
}

/** Retrieve all facts for a session, ordered by creation time ascending. */
export function getSessionFacts(
  db: Database.Database,
  sessionId: string,
): SessionFact[] {
  return db
    .prepare(
      `SELECT * FROM session_facts WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId) as SessionFact[];
}

/** Retrieve all session facts that have not yet been claimed by a consolidation run. */
export function getUnconsolidatedFacts(
  db: Database.Database,
): SessionFact[] {
  return db
    .prepare(
      `SELECT * FROM session_facts WHERE consolidation_id IS NULL ORDER BY created_at ASC`,
    )
    .all() as SessionFact[];
}

/** Retrieve unconsolidated session facts for a specific session. */
export function getUnconsolidatedSessionFacts(
  db: Database.Database,
  sessionId: string,
): SessionFact[] {
  return db
    .prepare(
      `SELECT * FROM session_facts
       WHERE session_id = ? AND consolidation_id IS NULL
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as SessionFact[];
}

/**
 * Atomically claim all unclaimed session facts for a consolidation run.
 * Caller must hold the consolidation lock — see consolidation-lock.ts.
 * Returns the number of facts claimed.
 */
export function claimForConsolidation(
  db: Database.Database,
  consolidationId: string,
): number {
  const result = db.prepare(
    `UPDATE session_facts SET consolidation_id = ? WHERE consolidation_id IS NULL`,
  ).run(consolidationId);
  return result.changes;
}

/** Retrieve all session facts claimed by a specific consolidation run. */
export function getClaimedFacts(
  db: Database.Database,
  consolidationId: string,
): SessionFact[] {
  return db
    .prepare(
      `SELECT * FROM session_facts WHERE consolidation_id = ? ORDER BY created_at ASC`,
    )
    .all(consolidationId) as SessionFact[];
}

// ---------------------------------------------------------------------------
// Session Fact Sources
// ---------------------------------------------------------------------------

/**
 * Link a session event as a provenance source for a session fact.
 * Uses INSERT OR IGNORE so duplicate links are silently ignored.
 */
export function linkFactSource(
  db: Database.Database,
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
  db: Database.Database,
  sessionFactId: string,
): SessionFactSource[] {
  return db
    .prepare(
      `SELECT * FROM session_fact_sources WHERE session_fact_id = ?`,
    )
    .all(sessionFactId) as SessionFactSource[];
}
