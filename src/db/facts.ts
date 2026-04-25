/**
 * Data access for graduated facts (DIKW: Knowledge layer).
 * All functions are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Fact } from "../types/data.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface NewFact {
  content: string;
  domain: string;
  subdomain?: string | null;
  confidence?: number;
  importance?: number;
  source_type: string;
  source_tool?: string | null;
  source_id?: string | null;
  valid_from?: string | null;
  session_id?: string | null;
  capture_context?: string | null;
  /** Which intelligence provider produced this fact. Defaults to 'heuristic'. */
  source_quality?: "heuristic" | "cli" | "sampling" | "explicit";
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** Insert a graduated fact. Returns the created Fact.
 *  valid_from defaults to now if not provided. Pass null explicitly for unknown validity start (e.g., historical imports). */
export function insertFact(db: Database.Database, fact: NewFact): Fact {
  const id = randomUUID();
  const now = new Date().toISOString();
  const confidence = fact.confidence ?? 0.7;
  const importance = fact.importance ?? 0.5;
  const subdomain = fact.subdomain ?? null;
  const sourceTool = fact.source_tool ?? null;
  const sourceId = fact.source_id ?? null;
  const validFrom = fact.valid_from !== undefined ? fact.valid_from : now;
  const sessionId = fact.session_id ?? null;
  const captureContext = fact.capture_context ?? null;
  const sourceQuality = fact.source_quality ?? "heuristic";

  const result = db.prepare(
    `INSERT INTO facts
       (id, content, domain, subdomain, confidence, importance,
        source_type, source_tool, source_id, status, superseded_by,
        is_latest, created_at, valid_from, valid_until,
        system_retired_at, session_id, capture_context, access_count, source_quality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL,
             1, ?, ?, NULL, NULL, ?, ?, 0, ?)`,
  ).run(
    id,
    fact.content,
    fact.domain,
    subdomain,
    confidence,
    importance,
    fact.source_type,
    sourceTool,
    sourceId,
    now,
    validFrom,
    sessionId,
    captureContext,
    sourceQuality,
  );

  if (result.changes === 0) {
    throw new Error(`Failed to insert fact '${id}'`);
  }

  return {
    id,
    content: fact.content,
    domain: fact.domain,
    subdomain,
    confidence,
    importance,
    source_type: fact.source_type,
    source_tool: sourceTool,
    source_id: sourceId,
    status: "active",
    superseded_by: null,
    is_latest: true,
    created_at: now,
    valid_from: validFrom,
    valid_until: null,
    system_retired_at: null,
    session_id: sessionId,
    capture_context: captureContext,
    access_count: 0,
    source_quality: sourceQuality,
  };
}

/** Retrieve a fact by ID. */
export function getFact(db: Database.Database, id: string): Fact | null {
  const row = db.prepare(`SELECT * FROM facts WHERE id = ?`).get(id) as
    | (Omit<Fact, "is_latest"> & { is_latest: number })
    | undefined;
  if (!row) return null;
  return { ...row, is_latest: row.is_latest === 1 };
}

/** Get all active, latest facts for a domain. */
export function getFactsByDomain(
  db: Database.Database,
  domain: string,
  subdomain?: string,
): Fact[] {
  // is_latest is the canonical current-state predicate. The valid_until guard
  // is defence-in-depth: if any code path ever mutates a fact with is_latest=1
  // AND valid_until set, we still exclude it from current-state results.
  let sql = `SELECT * FROM facts
             WHERE domain = ? AND status = 'active' AND is_latest = 1
               AND (valid_until IS NULL OR valid_until > datetime('now'))`;
  const params: unknown[] = [domain];

  if (subdomain !== undefined) {
    sql += ` AND subdomain = ?`;
    params.push(subdomain);
  }

  // Deterministic ordering: newest first. Required for stable supersession candidate selection.
  sql += ` ORDER BY created_at DESC`;

  const rows = db.prepare(sql).all(...params) as Array<
    Omit<Fact, "is_latest"> & { is_latest: number }
  >;

  return rows.map((row) => ({ ...row, is_latest: row.is_latest === 1 }));
}

/** Get facts linked to an entity. */
export function getFactsByEntity(
  db: Database.Database,
  entityId: string,
): Fact[] {
  const rows = db
    .prepare(
      `SELECT f.* FROM facts f
       JOIN fact_entities fe ON f.id = fe.fact_id
       WHERE fe.entity_id = ? AND f.status = 'active' AND f.is_latest = 1
         AND (f.valid_until IS NULL OR f.valid_until > datetime('now'))`,
    )
    .all(entityId) as Array<Omit<Fact, "is_latest"> & { is_latest: number }>;

  return rows.map((row) => ({ ...row, is_latest: row.is_latest === 1 }));
}

/** Supersede a fact: mark old as superseded, insert new. Returns the new Fact.
 *  valid_from on the replacement is always set to now — the replacement becomes true at supersession time.
 *  Throws if oldId does not exist. */
export function supersedeFact(
  db: Database.Database,
  oldId: string,
  newFact: NewFact,
): Fact {
  const newId = randomUUID();
  const now = new Date().toISOString();
  const confidence = newFact.confidence ?? 0.7;
  const importance = newFact.importance ?? 0.5;
  const subdomain = newFact.subdomain ?? null;
  const sourceTool = newFact.source_tool ?? null;
  const sourceId = newFact.source_id ?? null;
  const sessionId = newFact.session_id ?? null;
  const captureContext = newFact.capture_context ?? null;
  const sourceQuality = newFact.source_quality ?? "heuristic";

  const result = db.transaction(() => {
    const updated = db.prepare(
      `UPDATE facts
       SET status = 'superseded', superseded_by = ?, is_latest = 0, valid_until = ?
       WHERE id = ?`,
    ).run(newId, now, oldId);

    if (updated.changes === 0) {
      throw new Error(`Cannot supersede fact '${oldId}': not found`);
    }

    db.prepare(
      `INSERT INTO facts
         (id, content, domain, subdomain, confidence, importance,
          source_type, source_tool, source_id, status, superseded_by,
          is_latest, created_at, valid_from, valid_until,
          system_retired_at, session_id, capture_context, access_count, source_quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL,
               1, ?, ?, NULL, NULL, ?, ?, 0, ?)`,
    ).run(
      newId,
      newFact.content,
      newFact.domain,
      subdomain,
      confidence,
      importance,
      newFact.source_type,
      sourceTool,
      sourceId,
      now,
      now,
      sessionId,
      captureContext,
      sourceQuality,
    );

    return {
      id: newId,
      content: newFact.content,
      domain: newFact.domain,
      subdomain,
      confidence,
      importance,
      source_type: newFact.source_type,
      source_tool: sourceTool,
      source_id: sourceId,
      status: "active" as const,
      superseded_by: null,
      is_latest: true,
      created_at: now,
      valid_from: now,
      valid_until: null,
      system_retired_at: null,
      session_id: sessionId,
      capture_context: captureContext,
      access_count: 0,
      source_quality: sourceQuality,
    } satisfies Fact;
  })();

  return result;
}

/**
 * Strip FTS5 operators from a query string so it can be safely passed to MATCH.
 * Wraps each whitespace-delimited term in double quotes to force literal matching.
 * Note: this is per-term matching, not phrase matching. "hiking in mountains"
 * becomes three separate term matches, not a phrase.
 * Returns empty string if input is empty/whitespace-only.
 */
export function sanitiseFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

/** Keyword search via FTS5. Returns facts with BM25 rank.
 *  @throws {SqliteError} on malformed FTS5 syntax. Use sanitiseFtsQuery for untrusted input. */
export function keywordSearch(
  db: Database.Database,
  query: string,
  limit?: number,
): Array<{ fact: Fact; rank: number }> {
  const effectiveLimit = limit ?? 20;

  const rows = db
    .prepare(
      `SELECT f.*, fts.rank
       FROM facts_fts fts
       JOIN facts f ON f.rowid = fts.rowid
       WHERE facts_fts MATCH ? AND f.status = 'active' AND f.is_latest = 1
         AND (f.valid_until IS NULL OR f.valid_until > datetime('now'))
       ORDER BY fts.rank
       LIMIT ?`,
    )
    .all(query, effectiveLimit) as Array<
    Omit<Fact, "is_latest"> & { is_latest: number; rank: number }
  >;

  return rows.map((row) => {
    const { rank, ...rest } = row;
    return { fact: { ...rest, is_latest: rest.is_latest === 1 }, rank };
  });
}

/** Increment access_count for a fact. */
export function incrementFactAccess(
  db: Database.Database,
  factId: string,
): void {
  db.prepare(
    `UPDATE facts SET access_count = access_count + 1 WHERE id = ?`,
  ).run(factId);
}
