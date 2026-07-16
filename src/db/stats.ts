/**
 * Knowledge base statistics.
 * All functions are synchronous.
 *
 * Shared by the `get_stats` MCP tool and the `openmemory stats` CLI so the two
 * can never disagree about what the store contains.
 */

import type { Db } from "./connection.js";

export interface KnowledgeStats {
  facts: {
    /** Currently-true facts: active, latest, and within their validity window. */
    active_latest: number;
    /** Every fact ever recorded, including superseded ones (history is kept). */
    total: number;
  };
  entities: number;
  domains: number;
  consolidations: number;
  domain_distribution: Array<{ domain: string; count: number }>;
}

/** The filter defining a "currently true" fact — kept identical everywhere. */
const CURRENT = `status = 'active' AND is_latest = 1
  AND (valid_until IS NULL OR valid_until > datetime('now'))`;

function count(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Snapshot of what the knowledge base currently holds. */
export function getStats(db: Db): KnowledgeStats {
  const domainDistribution = db
    .prepare(
      `SELECT domain, COUNT(*) as count FROM facts
       WHERE ${CURRENT}
       GROUP BY domain
       ORDER BY count DESC
       LIMIT 50`,
    )
    .all() as Array<{ domain: string; count: number }>;

  return {
    facts: {
      active_latest: count(db, `SELECT COUNT(*) as count FROM facts WHERE ${CURRENT}`),
      total: count(db, `SELECT COUNT(*) as count FROM facts`),
    },
    entities: count(db, `SELECT COUNT(*) as count FROM entities`),
    domains: count(db, `SELECT COUNT(*) as count FROM domains`),
    consolidations: count(db, `SELECT COUNT(*) as count FROM consolidations`),
    domain_distribution: domainDistribution,
  };
}
