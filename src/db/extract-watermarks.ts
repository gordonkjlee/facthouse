/**
 * Per-conversation extract clock.
 *
 * `consolidations.last_event_sequence` is an audit of what a run believed
 * the global through was. It is not the live clock: a situation satellite
 * or a historical run row can sit above a neighbour’s unexamined events.
 * This table is how far extract has read each conversation, the same idea
 * as `source_watermarks` for pull (two clocks, independent).
 */

import type { Db } from "./connection.js";

export type ExtractConversationRef = {
  kind: "client" | "mcp" | "unkeyed";
  id: string;
};

/**
 * Map an event row to `extract_watermarks`. Alias the events table `e`.
 * Same order as `conversationRef` / prune: client, then mcp, then the row id.
 */
export const EXTRACT_WATERMARK_JOIN = `
  LEFT JOIN extract_watermarks w
    ON w.kind = CASE
         WHEN NULLIF(e.client_session_id, '') IS NOT NULL THEN 'client'
         WHEN NULLIF(e.mcp_session_id, '') IS NOT NULL THEN 'mcp'
         ELSE 'unkeyed'
       END
   AND w.conversation_id = CASE
         WHEN NULLIF(e.client_session_id, '') IS NOT NULL THEN e.client_session_id
         WHEN NULLIF(e.mcp_session_id, '') IS NOT NULL THEN e.mcp_session_id
         ELSE e.id
       END`;

export const UNEXAMINED_EVENT_PREDICATE =
  "e.sequence > COALESCE(w.last_event_sequence, 0)";

/**
 * Largest N such that every `session_events.sequence <= N` has been
 * examined or declined for its conversation. Scalar subquery, one definition,
 * used by prune as well as `extractWatermark()`.
 */
export const EXTRACT_WATERMARK_SQL = `COALESCE(
    (SELECT MIN(e.sequence) - 1
       FROM session_events e
       ${EXTRACT_WATERMARK_JOIN}
      WHERE ${UNEXAMINED_EVENT_PREDICATE}),
    (SELECT MAX(sequence) FROM session_events),
    0
  )`;

export interface UnexaminedConversation {
  kind: ExtractConversationRef["kind"];
  id: string;
  minSequence: number;
}

function refKind(ref: ExtractConversationRef): string {
  return ref.kind;
}

function refId(ref: ExtractConversationRef): string {
  return ref.id;
}

/** Per-conversation mark. Missing row = 0. */
export async function conversationExtractThrough(
  db: Db,
  ref: ExtractConversationRef,
): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT last_event_sequence AS seq
         FROM extract_watermarks
        WHERE kind = ? AND conversation_id = ?`,
    )
    .get(refKind(ref), refId(ref))) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

/**
 * Live global through. Not `MAX(consolidations.last_event_sequence)`.
 */
export async function extractWatermark(db: Db): Promise<number> {
  const row = (await db
    .prepare(`SELECT ${EXTRACT_WATERMARK_SQL} AS seq`)
    .get()) as { seq: number };
  return row?.seq ?? 0;
}

/** Events not covered by any extract_watermarks row. */
export async function unexaminedEventCount(db: Db): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM session_events e
         ${EXTRACT_WATERMARK_JOIN}
        WHERE ${UNEXAMINED_EVENT_PREDICATE}`,
    )
    .get()) as { n: number };
  return row?.n ?? 0;
}

export async function listUnexaminedConversations(
  db: Db,
): Promise<UnexaminedConversation[]> {
  const rows = (await db
    .prepare(
      `SELECT
         CASE
           WHEN NULLIF(e.client_session_id, '') IS NOT NULL THEN 'client'
           WHEN NULLIF(e.mcp_session_id, '') IS NOT NULL THEN 'mcp'
           ELSE 'unkeyed'
         END AS kind,
         CASE
           WHEN NULLIF(e.client_session_id, '') IS NOT NULL THEN e.client_session_id
           WHEN NULLIF(e.mcp_session_id, '') IS NOT NULL THEN e.mcp_session_id
           ELSE e.id
         END AS conversation_id,
         MIN(e.sequence) AS min_seq
         FROM session_events e
         ${EXTRACT_WATERMARK_JOIN}
        WHERE ${UNEXAMINED_EVENT_PREDICATE}
        GROUP BY 1, 2
        ORDER BY min_seq ASC`,
    )
    .all()) as Array<{
    kind: ExtractConversationRef["kind"];
    conversation_id: string;
    min_seq: number;
  }>;
  return rows.map((r) => ({
    kind: r.kind,
    id: r.conversation_id,
    minSequence: r.min_seq,
  }));
}

/** Advance a conversation’s mark. Never moves backwards. */
export async function setConversationExtractThrough(
  db: Db,
  ref: ExtractConversationRef,
  sequence: number,
): Promise<void> {
  const updated_at = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO extract_watermarks
         (kind, conversation_id, last_event_sequence, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, conversation_id) DO UPDATE SET
         last_event_sequence = excluded.last_event_sequence,
         updated_at = excluded.updated_at
       WHERE excluded.last_event_sequence > extract_watermarks.last_event_sequence`,
    )
    .run(refKind(ref), refId(ref), sequence, updated_at);
}

/**
 * Policy-off / test helper: every conversation is declined through its
 * current max sequence. Does not invent extract. Does not go backwards.
 */
export async function advanceExtractMarksToCurrentMax(db: Db): Promise<void> {
  const rows = (await db
    .prepare(
      `SELECT
         CASE
           WHEN NULLIF(e.client_session_id, '') IS NOT NULL THEN 'client'
           WHEN NULLIF(e.mcp_session_id, '') IS NOT NULL THEN 'mcp'
           ELSE 'unkeyed'
         END AS kind,
         CASE
           WHEN NULLIF(e.client_session_id, '') IS NOT NULL THEN e.client_session_id
           WHEN NULLIF(e.mcp_session_id, '') IS NOT NULL THEN e.mcp_session_id
           ELSE e.id
         END AS conversation_id,
         MAX(e.sequence) AS mx
         FROM session_events e
        GROUP BY 1, 2`,
    )
    .all()) as Array<{
    kind: ExtractConversationRef["kind"];
    conversation_id: string;
    mx: number;
  }>;
  for (const row of rows) {
    await setConversationExtractThrough(
      db,
      { kind: row.kind, id: row.conversation_id },
      row.mx,
    );
  }
}

/**
 * v19 seed: the old global MAX still means every event at or below it was
 * examined or declined. Copy that onto per-conversation rows so a finished
 * store is not re-extracted. Reads `MAX(consolidations.last_event_sequence)`
 * once, as history, then never again as a live clock.
 */
export async function seedExtractWatermarksFromConsolidations(
  db: Db,
): Promise<void> {
  const updated_at = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO extract_watermarks
         (kind, conversation_id, last_event_sequence, updated_at)
       SELECT kind, cid, MAX(sequence), ?
         FROM (
           SELECT
             CASE
               WHEN NULLIF(client_session_id, '') IS NOT NULL THEN 'client'
               WHEN NULLIF(mcp_session_id, '') IS NOT NULL THEN 'mcp'
               ELSE 'unkeyed'
             END AS kind,
             CASE
               WHEN NULLIF(client_session_id, '') IS NOT NULL THEN client_session_id
               WHEN NULLIF(mcp_session_id, '') IS NOT NULL THEN mcp_session_id
               ELSE id
             END AS cid,
             sequence
           FROM session_events
           WHERE sequence <= (
             SELECT COALESCE(MAX(last_event_sequence), 0) FROM consolidations
           )
         )
        GROUP BY kind, cid`,
    )
    .run(updated_at);
}
