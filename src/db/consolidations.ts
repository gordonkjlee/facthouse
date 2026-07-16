/**
 * Data access for consolidation runs.
 * All functions are synchronous.
 */

import type { Db } from "./connection.js";
import type { Consolidation } from "../types/data.js";

/** Shape as stored: open_threads is a JSON-encoded TEXT column. */
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
  created_at: string;
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
    created_at: row.created_at,
  };
}

/** The most recent consolidation run, or null if none have happened. */
export function getLatestConsolidation(db: Db): Consolidation | null {
  const row = db
    .prepare(`SELECT * FROM consolidations ORDER BY created_at DESC LIMIT 1`)
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
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get() as unknown as ConsolidationRow | undefined;
  return row ? hydrate(row) : null;
}
