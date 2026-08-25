/**
 * Keyword search over session_events when graduated knowledge is empty.
 *
 * Not a second retrieval product: hybridSearch only calls this when `results`
 * is empty. The slice is raw D — not extracted, not reconciled — so it stays
 * off the `results` list. Neighbours of a hit are the window; last-N as a
 * pronoun dictionary is not this.
 */

import type { Db } from "../db/connection.js";
import type { EpisodeSlice, SessionEvent } from "../types/data.js";
import { conversationRef } from "../db/sessions.js";

/** Events either side of a hit, inclusive of the hit. */
export const EPISODE_RADIUS = 2;

/** Conversations returned in one search. */
export const EPISODE_SLICE_CAP = 3;

/** FTS hits considered before grouping into slices. */
export const EPISODE_HIT_CAP = 8;

/** Max events in one returned slice after merging overlapping windows. */
export const EPISODE_EVENT_CAP = 8;

/** Truncate a single event so a tool_result dump cannot drown the answer. */
export const EPISODE_CONTENT_CHARS = 500;

/**
 * What to tell the caller when K is empty but D hit.
 * One string, used by hybridSearch and asserted in tests.
 */
export const EPISODE_REFINEMENT =
  "No graduated facts matched. `episodes` is a short raw-log window around a keyword hit — not yet extracted.";

/** Same partition as prune: client chat, else MCP connection, else the row. */
const CONVERSATION_KEY = `COALESCE(NULLIF(client_session_id, ''), NULLIF(mcp_session_id, ''), id)`;

interface HitRow {
  id: string;
  mcp_session_id: string | null;
  client_session_id: string | null;
  sequence: number;
}

interface WindowRow {
  id: string;
  sequence: number;
  event_type: SessionEvent["event_type"];
  role: SessionEvent["role"];
  content: string | null;
}

/** Keyword-match session_events and return a short window around each hit. */
export function searchEpisodes(db: Db, sanitisedQuery: string): EpisodeSlice[] {
  if (!sanitisedQuery) return [];

  const hits = db
    .prepare(
      `SELECT e.id, e.mcp_session_id, e.client_session_id, e.sequence
         FROM session_events_fts fts
         JOIN session_events e ON e.rowid = fts.rowid
        WHERE session_events_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?`,
    )
    .all(sanitisedQuery, EPISODE_HIT_CAP) as unknown as HitRow[];

  if (hits.length === 0) return [];

  const groups = new Map<string, HitRow[]>();
  const order: string[] = [];
  for (const hit of hits) {
    const key = conversationKey(hit);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(hit);
  }

  const slices: EpisodeSlice[] = [];
  for (const key of order.slice(0, EPISODE_SLICE_CAP)) {
    const groupHits = groups.get(key)!;
    const matchedIds = new Set(groupHits.map((h) => h.id));
    const seqs = groupHits.map((h) => h.sequence);
    const lo = Math.max(1, Math.min(...seqs) - EPISODE_RADIUS);
    const hi = Math.max(...seqs) + EPISODE_RADIUS;
    const rows = db
      .prepare(
        `SELECT id, sequence, event_type, role, content
           FROM session_events
          WHERE ${CONVERSATION_KEY} = ?
            AND sequence BETWEEN ? AND ?
          ORDER BY sequence ASC
          LIMIT ?`,
      )
      .all(key, lo, hi, EPISODE_EVENT_CAP) as unknown as WindowRow[];

    slices.push({
      conversation_id: key,
      events: rows.map((e) => ({
        id: e.id,
        sequence: e.sequence,
        role: e.role,
        event_type: e.event_type,
        content: clip(e.content),
        matched: matchedIds.has(e.id),
      })),
    });
  }
  return slices;
}

function conversationKey(event: {
  id: string;
  client_session_id: string | null;
  mcp_session_id: string | null;
}): string {
  const ref = conversationRef(event);
  return ref ? ref.id : event.id;
}

function clip(content: string | null): string | null {
  if (content === null) return null;
  if (content.length <= EPISODE_CONTENT_CHARS) return content;
  return content.slice(0, EPISODE_CONTENT_CHARS);
}
