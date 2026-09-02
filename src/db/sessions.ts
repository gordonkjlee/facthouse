/**
 * Data access for sessions and session events.
 */

import { randomUUID } from "node:crypto";
import { withTransaction } from "./connection.js";
import type { Db } from "./connection.js";
import type { Session, SessionEvent } from "../types/data.js";
import { speakerNameOf } from "./session-facts.js";
import { ensureRoomForData } from "./disk-budget.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface NewSession {
  source_tool: string | null;
  project: string | null;
}

export interface NewSessionEvent {
  mcp_session_id?: string | null;
  client_session_id?: string | null;
  event_type: SessionEvent["event_type"];
  role: SessionEvent["role"];
  content_type?: SessionEvent["content_type"];
  content: string | null;
  content_ref?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * When the turn was said, if the source recorded it. Omit or null when
   * unknown — do not copy copy time here.
   */
  occurred_at?: string | null;
  speaker?: string | null;
}

export interface GetEventsOpts {
  after_sequence?: number;
  limit?: number;
}

/**
 * The conversation an event belongs to.
 *
 * `client_session_id` is the client's own conversation (a Claude Code JSONL
 * file, `record --session-id`, `FACTMEM_CLIENT_SESSION`). Prefer it:
 * `mcp_session_id` is our MCP connection, one per handshake, not one per chat.
 *
 * Pull writes only the client column and never calls `getLatestSession()`.
 * Events with neither column are unkeyed — examined and declined, not attached
 * to whatever was last active. SQL that partitions sessions must use the same
 * order: `COALESCE(NULLIF(client_session_id, ''), NULLIF(mcp_session_id, ''), id)` in `prune.ts`.
 */
export type ConversationRef = { kind: "client" | "mcp"; id: string };

export function conversationRef(event: {
  client_session_id: string | null;
  mcp_session_id: string | null;
}): ConversationRef | null {
  // Empty string is the same as null: COALESCE would treat it as a key,
  // so prune uses NULLIF to match this truthiness.
  const client = event.client_session_id || null;
  const mcp = event.mcp_session_id || null;
  if (client) return { kind: "client", id: client };
  if (mcp) return { kind: "mcp", id: mcp };
  return null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Create a new session and return it. */
export async function createSession(
  db: Db,
  opts: NewSession,
): Promise<Session> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO sessions (id, source_tool, project, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, opts.source_tool, opts.project, now, now);

  return {
    id,
    source_tool: opts.source_tool,
    project: opts.project,
    started_at: now,
    last_activity_at: now,
  };
}

/**
 * Make sure a session row exists for this id.
 *
 * Pull uses the client's conversation id (the JSONL file name / payload
 * sessionId) as `sessions.id`, so `client_session_id` on events joins to
 * `sessions.project`. MCP `createSession` still mints a UUID.
 *
 * `project` is provenance of which project group produced the conversation,
 * not a tenant. A later call fills a null project; it does not overwrite one
 * that is already set.
 */
export async function ensureSession(
  db: Db,
  opts: { id: string; source_tool: string | null; project: string | null },
): Promise<Session> {
  const existing = await getSession(db, opts.id);
  if (existing) {
    if (existing.project == null && opts.project != null) {
      await db.prepare(
        `UPDATE sessions SET project = ? WHERE id = ? AND project IS NULL`,
      ).run(opts.project, opts.id);
      return { ...existing, project: opts.project };
    }
    return existing;
  }

  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO sessions (id, source_tool, project, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.id, opts.source_tool, opts.project, now, now);

  return {
    id: opts.id,
    source_tool: opts.source_tool,
    project: opts.project,
    started_at: now,
    last_activity_at: now,
  };
}

/** Update the last_activity_at timestamp for a session. */
export async function updateLastActivity(
  db: Db,
  sessionId: string,
): Promise<void> {
  await db.prepare(
    `UPDATE sessions SET last_activity_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), sessionId);
}

/** Retrieve a session by ID, or null if not found. */
export async function getSession(
  db: Db,
  sessionId: string,
): Promise<Session | null> {
  const row = await db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
  return (row as unknown as Session) ?? null;
}

/** Get the most recently active session, or null if none exist. */
export async function getLatestSession(
  db: Db,
): Promise<Session | null> {
  const row = await db.prepare(
    `SELECT * FROM sessions ORDER BY last_activity_at DESC, rowid DESC LIMIT 1`,
  ).get();
  return (row as unknown as Session) ?? null;
}

// ---------------------------------------------------------------------------
// Session Events
// ---------------------------------------------------------------------------

/**
 * Insert a new event. Assigns the next global sequence number
 * and updates the MCP session's last_activity_at (if applicable).
 */
export async function insertEvent(
  db: Db,
  event: NewSessionEvent,
): Promise<SessionEvent> {
  await ensureRoomForData(db);

  const id = randomUUID();
  const now = new Date().toISOString();
  // Empty string is missing — same truthiness as conversationRef / prune NULLIF.
  // `??` would store "" and then working-memory SQL (`IS NULL`) would skip the row.
  const mcpSessionId = event.mcp_session_id || null;
  const clientSessionId = event.client_session_id || null;
  const contentType = event.content_type ?? "text";
  const contentRef = event.content_ref ?? null;
  const metadata = event.metadata ? JSON.stringify(event.metadata) : null;
  const occurredAt = event.occurred_at || null;
  const speaker = speakerNameOf(event.speaker);

  const result = await withTransaction(db, async () => {
    const seqRow = (await db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM session_events`,
      )
      .get()) as { max_seq: number };

    const sequence = seqRow.max_seq + 1;

    await db.prepare(
      `INSERT INTO session_events
         (id, mcp_session_id, client_session_id, sequence, event_type, role,
          content_type, content, content_ref, metadata, created_at, occurred_at,
          speaker)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      mcpSessionId,
      clientSessionId,
      sequence,
      event.event_type,
      event.role,
      contentType,
      event.content,
      contentRef,
      metadata,
      now,
      occurredAt,
      speaker,
    );

    if (mcpSessionId) {
      await db.prepare(
        `UPDATE sessions SET last_activity_at = ? WHERE id = ?`,
      ).run(now, mcpSessionId);
    }

    return {
      id,
      mcp_session_id: mcpSessionId,
      client_session_id: clientSessionId,
      sequence,
      event_type: event.event_type,
      role: event.role,
      content_type: contentType,
      content: event.content,
      content_ref: contentRef,
      metadata: event.metadata ?? null,
      created_at: now,
      occurred_at: occurredAt,
      speaker,
    } satisfies SessionEvent;
  });

  return result;
}

/** Look up one event by id. */
export async function getEventById(db: Db, id: string): Promise<SessionEvent | null> {
  const row = (await db
    .prepare(`SELECT * FROM session_events WHERE id = ?`)
    .get(id)) as
    | (Omit<SessionEvent, "metadata"> & { metadata: string | null })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}

/** Retrieve events for a session, ordered by sequence. */
export async function getEvents(
  db: Db,
  sessionId: string,
  opts?: GetEventsOpts,
): Promise<SessionEvent[]> {
  const afterSeq = opts?.after_sequence ?? 0;
  const limit = opts?.limit ?? 1000;

  const rows = (await db
    .prepare(
      `SELECT * FROM session_events
       WHERE (mcp_session_id = ? OR client_session_id = ?) AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .all(sessionId, sessionId, afterSeq, limit)) as Array<
    Omit<SessionEvent, "metadata"> & { metadata: string | null }
  >;

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  }));
}

/** Count the total number of events matching a session ID. */
export async function getEventCount(
  db: Db,
  sessionId: string,
): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) AS count FROM session_events
       WHERE mcp_session_id = ? OR client_session_id = ?`,
    )
    .get(sessionId, sessionId)) as { count: number };
  return row.count;
}
