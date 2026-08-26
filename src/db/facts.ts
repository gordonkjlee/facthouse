/**
 * Data access for graduated facts (DIKW: Knowledge layer).
 * All functions are synchronous.
 */

import { randomUUID } from "node:crypto";
import { withTransaction } from "./connection.js";
import type { Db, SqlParam } from "./connection.js";
import type { Fact, EntityFact } from "../types/data.js";
// The one reserved relationship value. Imported rather than repeated, because a
// second copy of a magic string is a second definition with its own future.
import { SUBJECT_OF } from "./entities.js";

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

/** Options for a supersession write. */
export interface SupersedeOpts {
  /**
   * When true, stamp `system_retired_at` on the old fact (bi-temporal mode).
   * Default false — simple mode never writes the fourth clock.
   */
  retireSystemTime?: boolean;
}

/**
 * Optional as-of system-time filter on a fact read.
 *
 * `asOfSystemTime` must already be an ISO 8601 instant (`parseSystemTime`).
 * When set, the query is "what the system believed at T" rather than "what
 * is currently true": `created_at <= T AND (system_retired_at IS NULL OR
 * system_retired_at > T)`. That includes superseded facts the store still
 * held at T, and excludes facts it learned afterwards.
 */
export interface FactReadOpts {
  asOfSystemTime?: string;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

type FactRow = Omit<Fact, "is_latest"> & { is_latest: number };

function mapFact(row: FactRow): Fact {
  return { ...row, is_latest: row.is_latest === 1 };
}

/**
 * Normalise an as-of system-time argument to an ISO 8601 instant.
 *
 * Stored clocks are `Date.toISOString()` values. Comparing a date-only string
 * against those lexicographically drops every fact written later that UTC day,
 * so this parses through `Date` and re-emits the same format the columns use.
 */
export function parseSystemTime(input: string): string {
  const trimmed = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    throw new Error(
      `Invalid as-of system time '${input}'. Use an ISO 8601 instant, e.g. 2026-03-15T12:00:00Z.`,
    );
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid as-of system time '${input}'. Use an ISO 8601 instant, e.g. 2026-03-15T12:00:00Z.`,
    );
  }
  return parsed.toISOString();
}

/**
 * Currency predicate for a fact read — currently true, or believed at T.
 *
 * One definition. Callers that inlined `status = 'active' AND is_latest = 1`
 * would drift the first time either side of this fork changed.
 */
function currencyClause(
  alias: string,
  asOfSystemTime?: string,
): { sql: string; params: SqlParam[] } {
  const c = alias ? `${alias}.` : "";
  if (asOfSystemTime !== undefined) {
    return {
      sql:
        `${c}created_at <= ? AND (${c}system_retired_at IS NULL OR ` +
        `${c}system_retired_at > ?)`,
      params: [asOfSystemTime, asOfSystemTime],
    };
  }
  return {
    sql:
      `${c}status = 'active' AND ${c}is_latest = 1 ` +
      `AND (${c}valid_until IS NULL OR ${c}valid_until > datetime('now'))`,
    params: [],
  };
}

/** Insert a graduated fact. Returns the created Fact.
 *  valid_from defaults to now if not provided. Pass null explicitly for unknown validity start (e.g., historical imports). */
export function insertFact(db: Db, fact: NewFact): Fact {
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
export function getFact(db: Db, id: string): Fact | null {
  const row = db.prepare(`SELECT * FROM facts WHERE id = ?`).get(id) as
    | FactRow
    | undefined;
  if (!row) return null;
  return mapFact(row);
}

/**
 * Retrieve several facts by id, currently-true only — or believed at T when
 * `opts.asOfSystemTime` is set.
 *
 * For hydrating the winners of a ranked scan: the semantic path scores every
 * stored vector but only needs the top handful of fact rows, and one query
 * beats N round trips through `getFact`.
 *
 * Returns in arbitrary order and silently omits ids that are missing or no
 * longer in the requested set — callers hold their own ranking and re-project
 * through it.
 */
export function getFactsByIds(
  db: Db,
  ids: string[],
  opts?: FactReadOpts,
): Fact[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const currency = currencyClause("", opts?.asOfSystemTime);
  const rows = db
    .prepare(
      `SELECT * FROM facts
        WHERE id IN (${placeholders})
          AND ${currency.sql}`,
    )
    .all(...(ids as SqlParam[]), ...currency.params) as FactRow[];
  return rows.map(mapFact);
}

/** Get all currently-true facts for a domain — or those believed at T. */
export function getFactsByDomain(
  db: Db,
  domain: string,
  subdomain?: string,
  opts?: FactReadOpts,
): Fact[] {
  const currency = currencyClause("", opts?.asOfSystemTime);
  let sql = `SELECT * FROM facts
             WHERE domain = ? AND ${currency.sql}`;
  const params: SqlParam[] = [domain, ...currency.params];

  if (subdomain !== undefined) {
    sql += ` AND subdomain = ?`;
    params.push(subdomain);
  }

  // Deterministic ordering: newest first. Required for stable supersession candidate selection.
  sql += ` ORDER BY created_at DESC`;

  const rows = db.prepare(sql).all(...params) as FactRow[];
  return rows.map(mapFact);
}

/** Get facts linked to an entity. */
export function getFactsByEntity(
  db: Db,
  entityId: string,
  opts?: FactReadOpts,
): EntityFact[] {
  const currency = currencyClause("f", opts?.asOfSystemTime);
  const rows = db
    .prepare(
      // Facts *about* this entity come first, then facts that merely name it,
      // and importance orders within each group.
      //
      // Ranking, not filtering. Returning subjects alone would be wrong twice
      // over: "Robin approved Alex's transfer" is worth surfacing when asked
      // about Robin even though it is not about him, and no provider emits
      // subject links yet, so a subject-only query would answer almost every
      // question with nothing. This is the same conclusion the domain gate
      // reached the hard way — a signal that ranks degrades where one that
      // filters fails absolutely.
      //
      // MAX() because an entity can be linked to one fact more than once, with
      // different relationships; the fact is about it if any link says so.
      `SELECT f.*, MAX(fe.relationship = ?) AS is_subject
         FROM facts f
         JOIN fact_entities fe ON f.id = fe.fact_id
        WHERE fe.entity_id = ? AND ${currency.sql}
        GROUP BY f.id
        ORDER BY is_subject DESC, f.importance DESC, f.created_at DESC`,
    )
    .all(SUBJECT_OF, entityId, ...currency.params) as Array<
    FactRow & { is_subject: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_latest: row.is_latest === 1,
    is_subject: row.is_subject === 1,
  }));
}

/**
 * Facts the system believed at instant T.
 *
 * `created_at <= T AND (system_retired_at IS NULL OR system_retired_at > T)`.
 * In simple mode `system_retired_at` is never written, so this is not a
 * meaningful audit — callers that expose it must gate on bi-temporal mode.
 */
export function getFactsAsOfSystemTime(db: Db, at: string, limit = 100): Fact[] {
  const instant = parseSystemTime(at);
  const currency = currencyClause("", instant);
  const rows = db
    .prepare(
      `SELECT * FROM facts
        WHERE ${currency.sql}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(...currency.params, limit) as FactRow[];
  return rows.map(mapFact);
}

/** Supersede a fact: mark old as superseded, insert new. Returns the new Fact.
 *  valid_from on the replacement is the stated world-time if given, otherwise
 *  now — a preference change becomes true at supersession; a dated correction
 *  keeps the day extract resolved.
 *  Throws if oldId does not exist.
 *  `system_retired_at` is written only when `opts.retireSystemTime` is true
 *  (bi-temporal mode). Simple mode — the default — never populates it. */
export function supersedeFact(
  db: Db,
  oldId: string,
  newFact: NewFact,
  opts?: SupersedeOpts,
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
  const retireSystemTime = opts?.retireSystemTime === true;
  const validFrom =
    newFact.valid_from !== undefined && newFact.valid_from !== null
      ? newFact.valid_from
      : now;

  const result = withTransaction(db, () => {
    const updated = retireSystemTime
      ? db.prepare(
          `UPDATE facts
           SET status = 'superseded', superseded_by = ?, is_latest = 0,
               valid_until = ?, system_retired_at = ?
           WHERE id = ?`,
        ).run(newId, now, now, oldId)
      : db.prepare(
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
      validFrom,
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
      valid_from: validFrom,
      valid_until: null,
      system_retired_at: null,
      session_id: sessionId,
      capture_context: captureContext,
      access_count: 0,
      source_quality: sourceQuality,
    } satisfies Fact;
  });

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
  db: Db,
  query: string,
  limit?: number,
  opts?: FactReadOpts,
): Array<{ fact: Fact; rank: number }> {
  const effectiveLimit = limit ?? 20;
  const currency = currencyClause("f", opts?.asOfSystemTime);

  const rows = db
    .prepare(
      `SELECT f.*, fts.rank
       FROM facts_fts fts
       JOIN facts f ON f.rowid = fts.rowid
       WHERE facts_fts MATCH ? AND ${currency.sql}
       ORDER BY fts.rank
       LIMIT ?`,
    )
    .all(query, ...currency.params, effectiveLimit) as Array<
    FactRow & { rank: number }
  >;

  return rows.map((row) => {
    const { rank, ...rest } = row;
    return { fact: mapFact(rest), rank };
  });
}

/** Increment access_count for a fact. */
export function incrementFactAccess(
  db: Db,
  factId: string,
): void {
  db.prepare(
    `UPDATE facts SET access_count = access_count + 1 WHERE id = ?`,
  ).run(factId);
}
