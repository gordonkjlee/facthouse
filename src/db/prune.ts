/**
 * Reclaiming raw events that nothing can reach.
 *
 * `session_events` is the D layer of the pipeline: raw conversation and tool
 * output, read once by extraction and then kept for ever. On a store in daily
 * use that is almost all of the database — measured at 47,000 events and 493 MB
 * against 21 graduated facts, because agentic tool output is logged wholesale
 * and dwarfs everything a person actually says.
 *
 * **The rule is reachability, not age.** A clock is the wrong instrument here:
 * an event's value has nothing to do with how old it is, and a store that is
 * quiet for a month should not lose the events it has not extracted yet. An
 * event may go when nothing can ever reach it again — which is a question the
 * database can answer exactly.
 *
 * Three conditions, each protecting a different reader:
 *
 *   1. **Extraction has read it** (`sequence <= watermark`). Ahead of the
 *      watermark the event is still input, and deleting it would discard
 *      conversation that was never examined.
 *   2. **No fact's provenance points at it.** Facts chain back through
 *      `session_fact_sources.event_id`, so a referenced event is the answer to
 *      "why does it believe this?". Deleting it would leave facts whose
 *      justification is a dangling id — and there is no foreign key to notice.
 *   3. **It is not recent reachable D for its own session.** Forgetfulness
 *      reread and the short evidence prefix both read already-extracted events
 *      of this conversation. Without this spare, prune would delete the notes
 *      extract glances at when now/referents are not enough.
 *
 * Nothing here runs automatically. Deletion is irreversible and this is a
 * memory product; the caller asks, having been shown what would go.
 */

import type { Db, SqlParam } from "./connection.js";

export interface PruneStats {
  /** Number of events matching the rule. */
  events: number;
  /** Bytes of event content they hold. */
  bytes: number;
}

/**
 * The single definition of "unreachable", as a WHERE clause over `ranked`.
 *
 * Written once and used by both the count and the delete, so the two can never
 * disagree about what would be removed — a dry run that reports a different set
 * from the one the apply deletes is worse than no dry run at all.
 */
const UNREACHABLE = `
      r.sequence <= (SELECT COALESCE(MAX(last_event_sequence), 0) FROM consolidations)
  AND r.rn > ?
  AND NOT EXISTS (SELECT 1 FROM session_fact_sources s WHERE s.event_id = r.id)`;

/**
 * Rank each event within its own session, newest first.
 *
 * Must match `conversationRef` in sessions.ts: client id first (the Claude
 * chat), then mcp id (our connection), then the event id so an unkeyed row is
 * its own partition rather than being lumped in with every other orphan.
 * NULLIF matches JS truthiness (empty string is missing). Window functions
 * cannot call JS, so the expression is duplicated here on purpose.
 */
const RANKED = `
  WITH ranked AS (
    SELECT e.id AS id,
           e.sequence AS sequence,
           LENGTH(COALESCE(e.content, '')) AS size,
           ROW_NUMBER() OVER (
             PARTITION BY COALESCE(NULLIF(e.client_session_id, ''), NULLIF(e.mcp_session_id, ''), e.id)
             ORDER BY e.sequence DESC
           ) AS rn
      FROM session_events e
  )`;

/**
 * What `pruneEvents` would remove, without removing it.
 *
 * @param keepPerSession events per session to spare as working memory — pass
 *   `extraction.working_memory_size` so the guard tracks the setting it exists
 *   to protect rather than a second copy of the number.
 */
export function prunableEvents(db: Db, keepPerSession: number): PruneStats {
  const row = db
    .prepare(
      `${RANKED}
       SELECT COUNT(*) AS events, COALESCE(SUM(r.size), 0) AS bytes
         FROM ranked r
        WHERE ${UNREACHABLE}`,
    )
    .get(Math.max(0, keepPerSession) as SqlParam) as
    | { events: number; bytes: number }
    | undefined;
  return { events: row?.events ?? 0, bytes: row?.bytes ?? 0 };
}

/**
 * Delete unreachable events. Returns what was actually removed.
 *
 * Counts before deleting and inside the same transaction, so the number
 * reported is the number removed even if something writes concurrently.
 */
export function pruneEvents(db: Db, keepPerSession: number): PruneStats {
  const keep = Math.max(0, keepPerSession) as SqlParam;

  db.exec("BEGIN IMMEDIATE");
  try {
    const before = prunableEvents(db, keepPerSession);
    db.prepare(
      `DELETE FROM session_events
        WHERE id IN (${RANKED} SELECT r.id FROM ranked r WHERE ${UNREACHABLE})`,
    ).run(keep);
    db.exec("COMMIT");
    return before;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Rebuild the file to actually give the space back.
 *
 * Deleting rows leaves free pages inside the database; the file does not shrink
 * until it is rewritten. Separate from `pruneEvents` because VACUUM rewrites the
 * whole database, needs free disk space roughly equal to its current size, and
 * cannot run inside a transaction — so the caller should choose it knowingly
 * rather than discover it as a pause.
 */
export function vacuum(db: Db): void {
  db.exec("VACUUM");
}
