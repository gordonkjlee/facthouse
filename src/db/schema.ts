/**
 * Schema creation and versioning.
 * Uses PRAGMA user_version for migration tracking.
 */

import type Database from "better-sqlite3";

const CURRENT_VERSION = 1;

/** Read the current schema version from the database. */
export function getSchemaVersion(db: Database.Database): number {
  const row = db.pragma("user_version", { simple: true });
  return typeof row === "number" ? row : 0;
}

/** Apply any pending schema migrations. */
export function applySchema(db: Database.Database): void {
  const version = getSchemaVersion(db);

  if (version < 1) {
    applyV1(db);
  }
}

// ---------------------------------------------------------------------------
// Schema version 1 — sessions + session_events (DIKW Data layer)
// ---------------------------------------------------------------------------

function applyV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source_tool TEXT,
      project TEXT,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('message', 'tool_call', 'tool_result', 'artifact')),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'json', 'image', 'audio', 'binary')),
      content TEXT,
      content_ref TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session
      ON session_events(session_id, sequence);
  `);

  db.pragma(`user_version = ${CURRENT_VERSION}`);
}
