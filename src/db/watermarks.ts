/**
 * Per-file pull watermarks.
 *
 * Each named source file is tailed from a durable (path, byte offset,
 * fingerprint) so a crash/resume inserts new lines only, and a truncated
 * or replaced file is detected rather than tailed from a stale offset.
 */

import type { Db } from "./connection.js";

export interface SourceWatermark {
  path: string;
  byte_offset: number;
  line_number: number;
  fingerprint: string;
  updated_at: string;
}

/** Retrieve the watermark for a file, or null if it has never been pulled. */
export function getWatermark(db: Db, filePath: string): SourceWatermark | null {
  const row = db
    .prepare(
      `SELECT path, byte_offset, line_number, fingerprint, updated_at
         FROM source_watermarks WHERE path = ?`,
    )
    .get(filePath) as SourceWatermark | undefined;
  return row ?? null;
}

/** Insert or replace the watermark for a file. */
export function upsertWatermark(
  db: Db,
  watermark: Omit<SourceWatermark, "updated_at">,
): SourceWatermark {
  const updated_at = new Date().toISOString();
  db.prepare(
    `INSERT INTO source_watermarks (path, byte_offset, line_number, fingerprint, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       line_number = excluded.line_number,
       fingerprint = excluded.fingerprint,
       updated_at = excluded.updated_at`,
  ).run(
    watermark.path,
    watermark.byte_offset,
    watermark.line_number,
    watermark.fingerprint,
    updated_at,
  );
  return { ...watermark, updated_at };
}
