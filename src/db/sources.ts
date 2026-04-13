/**
 * Data access for provenance source records.
 * Each graduated fact points at a source row via facts.source_id, enabling
 * the provenance chain:
 *   Fact.source_id → sources.id
 *   sources.metadata.session_fact_id (JSON field, not a column)
 *   → session_fact_sources.session_fact_id → session_fact_sources.event_id
 *   → session_events.id
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Source } from "../types/data.js";

export interface NewSource {
  type: string;
  tool_id?: string | null;
  raw_content?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Insert a provenance source record. Returns the created Source. */
export function createSource(db: Database.Database, source: NewSource): Source {
  const id = randomUUID();
  const now = new Date().toISOString();
  const toolId = source.tool_id ?? null;
  const rawContent = source.raw_content ?? null;
  const metadata = source.metadata ? JSON.stringify(source.metadata) : null;

  db.prepare(
    `INSERT INTO sources (id, type, tool_id, timestamp, raw_content, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, source.type, toolId, now, rawContent, metadata);

  return {
    id,
    type: source.type,
    tool_id: toolId,
    timestamp: now,
    raw_content: rawContent,
    metadata: source.metadata ?? null,
  };
}

/** Retrieve a source by ID. */
export function getSource(db: Database.Database, id: string): Source | null {
  const row = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as
    | (Omit<Source, "metadata"> & { metadata: string | null })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}
