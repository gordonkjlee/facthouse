/**
 * SQLite connection management via better-sqlite3.
 * Synchronous — suits MCP tool handlers.
 */

import Database from "better-sqlite3";

/**
 * Open or create a SQLite database at the given path.
 * Pass ":memory:" for in-memory databases (tests).
 */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  return db;
}

/** Close the database connection. Safe to call multiple times. */
export function closeDatabase(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // Already closed — ignore.
  }
}
