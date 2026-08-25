/**
 * Data access for consolidation runs.
 * All functions are synchronous.
 */

import type { Db } from "./connection.js";
import type {
  Consolidation,
  Referent,
  TopicSegment,
} from "../types/data.js";

/**
 * Newest consolidation when `created_at` ties.
 *
 * `new Date().toISOString()` is millisecond resolution. Two consolidations in
 * the same millisecond (fast machines, Node 24 CI) then sort unstably on
 * created_at alone — the test that rebinds a referent and the live extract
 * that reads `now` both picked the earlier row. last_event_sequence is how
 * far the run got; rowid is insert order.
 */
export const NEWEST_CONSOLIDATION =
  "created_at DESC, last_event_sequence DESC, rowid DESC";

/** Shape as stored: open_threads / now_referents / segments are JSON TEXT. */
interface ConsolidationRow {
  id: string;
  session_id: string | null;
  facts_in: number;
  facts_graduated: number;
  facts_rejected: number;
  entities_created: number;
  entities_linked: number;
  supersessions: number;
  summary: string | null;
  open_threads: string | null;
  now: string | null;
  now_start_sequence: number | null;
  now_referents: string | null;
  segments: string | null;
  created_at: string;
}

function parseReferents(raw: string | null): Referent[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: Referent[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Referent).phrase === "string" &&
        typeof (item as Referent).binding === "string"
      ) {
        out.push({
          phrase: (item as Referent).phrase,
          binding: (item as Referent).binding,
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

function parseSegments(raw: string | null): TopicSegment[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: TopicSegment[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as TopicSegment).start_sequence === "number" &&
        typeof (item as TopicSegment).end_sequence === "number" &&
        typeof (item as TopicSegment).gist === "string"
      ) {
        const referents = Array.isArray((item as TopicSegment).referents)
          ? ((item as TopicSegment).referents as Referent[]).filter(
              (r) =>
                r &&
                typeof r.phrase === "string" &&
                typeof r.binding === "string",
            )
          : [];
        out.push({
          start_sequence: (item as TopicSegment).start_sequence,
          end_sequence: (item as TopicSegment).end_sequence,
          gist: (item as TopicSegment).gist,
          referents,
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

function hydrate(row: ConsolidationRow): Consolidation {
  let openThreads: string[] | null = null;
  if (row.open_threads) {
    try {
      const parsed = JSON.parse(row.open_threads);
      if (Array.isArray(parsed)) openThreads = parsed as string[];
    } catch {
      // Malformed JSON — treat as absent rather than failing the read.
    }
  }
  return {
    id: row.id,
    session_id: row.session_id,
    facts_in: row.facts_in,
    facts_graduated: row.facts_graduated,
    facts_rejected: row.facts_rejected,
    entities_created: row.entities_created,
    entities_linked: row.entities_linked,
    supersessions: row.supersessions,
    summary: row.summary,
    open_threads: openThreads,
    now: row.now ?? null,
    now_start_sequence: row.now_start_sequence ?? null,
    now_referents: parseReferents(row.now_referents),
    segments: parseSegments(row.segments),
    created_at: row.created_at,
  };
}

/** Situation stored for one conversation, read from the latest row that has it. */
export interface ConversationSituation {
  now: string | null;
  now_start_sequence: number | null;
  referents: Referent[];
  segments: TopicSegment[];
}

/** The most recent consolidation run, or null if none have happened. */
export function getLatestConsolidation(db: Db): Consolidation | null {
  const row = db
    .prepare(
      `SELECT * FROM consolidations ORDER BY ${NEWEST_CONSOLIDATION} LIMIT 1`,
    )
    .get() as unknown as ConsolidationRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * The most recent consolidation that actually produced a narrative summary.
 *
 * Distinct from `getLatestConsolidation`: a run inserts its row with a NULL
 * summary and fills it in afterwards, and runs that graduate nothing record a
 * row with no summary at all. So the newest row is often not the newest
 * *narrative* — callers wanting prose want this one.
 */
export function getLatestSummarised(db: Db): Consolidation | null {
  const row = db
    .prepare(
      `SELECT * FROM consolidations
       WHERE summary IS NOT NULL
       ORDER BY ${NEWEST_CONSOLIDATION}
       LIMIT 1`,
    )
    .get() as unknown as ConsolidationRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * Latest now / referents / segments for one conversation.
 *
 * Same "newest row for this session_id" pattern as the rolling summary.
 */
export function latestConversationSituation(
  db: Db,
  sessionId: string,
  excludeId?: string,
): ConversationSituation | null {
  const row = excludeId
    ? (db
        .prepare(
          `SELECT now, now_start_sequence, now_referents, segments
           FROM consolidations
           WHERE session_id = ? AND id != ?
             AND (now IS NOT NULL OR now_referents IS NOT NULL OR segments IS NOT NULL)
           ORDER BY ${NEWEST_CONSOLIDATION}
           LIMIT 1`,
        )
        .get(sessionId, excludeId) as
        | Pick<
            ConsolidationRow,
            "now" | "now_start_sequence" | "now_referents" | "segments"
          >
        | undefined)
    : (db
        .prepare(
          `SELECT now, now_start_sequence, now_referents, segments
           FROM consolidations
           WHERE session_id = ?
             AND (now IS NOT NULL OR now_referents IS NOT NULL OR segments IS NOT NULL)
           ORDER BY ${NEWEST_CONSOLIDATION}
           LIMIT 1`,
        )
        .get(sessionId) as
        | Pick<
            ConsolidationRow,
            "now" | "now_start_sequence" | "now_referents" | "segments"
          >
        | undefined);
  if (!row) return null;
  return {
    now: row.now ?? null,
    now_start_sequence: row.now_start_sequence ?? null,
    referents: parseReferents(row.now_referents) ?? [],
    segments: parseSegments(row.segments) ?? [],
  };
}

export function applySituation(
  db: Db,
  consolidationId: string,
  situation: ConversationSituation,
): void {
  db.prepare(
    `UPDATE consolidations
     SET now = ?, now_start_sequence = ?, now_referents = ?, segments = ?
     WHERE id = ?`,
  ).run(
    situation.now,
    situation.now_start_sequence,
    JSON.stringify(situation.referents),
    JSON.stringify(situation.segments),
    consolidationId,
  );
}
