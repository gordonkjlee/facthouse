/**
 * Data access for sessions and session events.
 * All functions are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Session, SessionEvent } from "../types/data.js";

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
}

export interface GetEventsOpts {
  after_sequence?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Create a new session and return it. */
export function createSession(
  db: Database.Database,
  opts: NewSession,
): Session {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
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

/** Update the last_activity_at timestamp for a session. */
export function updateLastActivity(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare(
    `UPDATE sessions SET last_activity_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), sessionId);
}

/** Retrieve a session by ID, or null if not found. */
export function getSession(
  db: Database.Database,
  sessionId: string,
): Session | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
  return (row as Session) ?? null;
}

/** Get the most recently active session, or null if none exist. */
export function getLatestSession(
  db: Database.Database,
): Session | null {
  const row = db.prepare(
    `SELECT * FROM sessions ORDER BY last_activity_at DESC, rowid DESC LIMIT 1`,
  ).get();
  return (row as Session) ?? null;
}

// ---------------------------------------------------------------------------
// Session Events
// ---------------------------------------------------------------------------

/**
 * Insert a new event. Assigns the next global sequence number
 * and updates the MCP session's last_activity_at (if applicable).
 */
export function insertEvent(
  db: Database.Database,
  event: NewSessionEvent,
): SessionEvent {
  const id = randomUUID();
  const now = new Date().toISOString();
  const mcpSessionId = event.mcp_session_id ?? null;
  const clientSessionId = event.client_session_id ?? null;
  const contentType = event.content_type ?? "text";
  const contentRef = event.content_ref ?? null;
  const metadata = event.metadata ? JSON.stringify(event.metadata) : null;

  const result = db.transaction(() => {
    const seqRow = db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM session_events`,
      )
      .get() as { max_seq: number };

    const sequence = seqRow.max_seq + 1;

    db.prepare(
      `INSERT INTO session_events
         (id, mcp_session_id, client_session_id, sequence, event_type, role,
          content_type, content, content_ref, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );

    if (mcpSessionId) {
      db.prepare(
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
    } satisfies SessionEvent;
  })();

  return result;
}

/** Retrieve events for a session, ordered by sequence. */
export function getEvents(
  db: Database.Database,
  sessionId: string,
  opts?: GetEventsOpts,
): SessionEvent[] {
  const afterSeq = opts?.after_sequence ?? 0;
  const limit = opts?.limit ?? 1000;

  const rows = db
    .prepare(
      `SELECT * FROM session_events
       WHERE (mcp_session_id = ? OR client_session_id = ?) AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .all(sessionId, sessionId, afterSeq, limit) as Array<
    Omit<SessionEvent, "metadata"> & { metadata: string | null }
  >;

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  }));
}

/** Count the total number of events matching a session ID. */
export function getEventCount(
  db: Database.Database,
  sessionId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM session_events
       WHERE mcp_session_id = ? OR client_session_id = ?`,
    )
    .get(sessionId, sessionId) as { count: number };
  return row.count;
}
