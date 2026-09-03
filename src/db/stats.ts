/**
 * Knowledge base statistics.
 *
 * Shared by the `get_stats` MCP tool and the `facthouse stats` CLI so the two
 * can never disagree about what the store contains.
 */

import type { Db } from "./connection.js";
import { prunableEvents } from "./prune.js";
import { getBoundDiskBudget, keepPerSessionOf, storeBytes } from "./disk-budget.js";
import { extractWatermark, unexaminedEventCount } from "./extract-watermarks.js";
import { currencyClause } from "./facts.js";
import { listIntelligenceRuns, listIntelligenceRunsSince } from "./intelligence-runs.js";
import {
  rollupRuns,
  type IntelligenceSpendStats,
} from "../intelligence/usage.js";
import {
  evaluateTokenBudget,
  getBoundTokenBudget,
  loadRunsForBudget,
  type TokenBudgetReport,
} from "../intelligence/token-budget.js";

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
  /**
   * Semantic-search coverage, one entry per model+dimension pair the store
   * holds vectors for. Empty when semantic search has never run.
   *
   * Grouped by model rather than counted against the configured one, because
   * the two disagreements worth seeing are both invisible otherwise: partial
   * coverage (a provider that failed mid-run, or a store consolidated before
   * embeddings were switched on), and vectors left behind by a model the store
   * no longer uses. Comparing `count` against `facts.active_latest` gives the
   * first; a pair that isn't the configured one gives the second.
   */
  embeddings: Array<{ model: string; dimensions: number; count: number }>;
  /**
   * The raw event layer beneath the facts.
   *
   * Reported because it is invisible everywhere else and routinely dwarfs
   * everything above it: a store in daily use was measured at 47,000 events and
   * 493 MB against 21 integrated facts, almost all of it logged tool output. The
   * facts were healthy, so no other number in this object hinted at it. See
   * `facthouse prune`.
   */
  events: {
    count: number;
    bytes: number;
    /** Unreachable D the existing prune rule would remove. Always computed. */
    reclaimable: { events: number; bytes: number };
  };
  /**
   * Main store size (SQLite pages, or Postgres database size) and the
   * optional disk budget. Omitted fields mean unknown or unset.
   */
  store?: { bytes?: number; budget_bytes?: number };
  /**
   * How far D→I has read. `watermark` is the global through (MIN of
   * unexamined sequences). `unextracted_events` is the count of events not
   * covered by `extract_watermarks`, not `max(sequence) − watermark` — that
   * subtraction treats a neighbour’s high mark as a drained backlog.
   */
  extract: { watermark: number; unextracted_events: number };
  /** session_facts not yet claimed by a integrate (`consolidation_id` is null). */
  pending_facts: number;
  /**
   * Billed intelligence: 24h and all-time roll-ups plus the last N runs.
   * Embeddings are not this number. Token keys are omitted when the provider
   * did not report them.
   */
  intelligence: IntelligenceSpendStats;
  /** Remaining token budget when `intelligence.token_budget` is set. */
  token_budget?: TokenBudgetReport;
  /**
   * CLI-only: whether a scheduler is bound for this data dir. MCP `get_stats`
   * omits it — the process answering the tool *is* the listener.
   */
  listener?: boolean;
}

/** Currently-true facts. One definition: `currencyClause` in facts.ts. */
const current = (alias = "") => currencyClause(alias).sql;
const CURRENT = current();

async function count(db: Db, sql: string): Promise<number> {
  const row = (await db.prepare(sql).get()) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Snapshot of what the knowledge base currently holds. */
export async function getStats(db: Db): Promise<KnowledgeStats> {
  const domainDistribution = (await db
    .prepare(
      `SELECT domain, COUNT(*) as count FROM facts
       WHERE ${CURRENT}
       GROUP BY domain
       ORDER BY count DESC
       LIMIT 50`,
    )
    .all()) as Array<{ domain: string; count: number }>;

  const embeddingCoverage = (await db
    .prepare(
      `SELECT e.model AS model, e.dimensions AS dimensions, COUNT(*) AS count
         FROM fact_embeddings e
         JOIN facts f ON f.id = e.fact_id
        WHERE ${current("f")}
        GROUP BY e.model, e.dimensions
        ORDER BY count DESC`,
    )
    .all()) as Array<{ model: string; dimensions: number; count: number }>;

  const eventVolume = (await db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(COALESCE(content, ''))), 0) AS bytes
         FROM session_events`,
    )
    .get()) as { count: number; bytes: number };

  const reclaimable = await prunableEvents(db, keepPerSessionOf(db));
  const bytes = await storeBytes(db);
  const budgetBytes = getBoundDiskBudget(db)?.bytes;
  const store =
    bytes != null || budgetBytes != null
      ? {
          ...(bytes != null ? { bytes } : {}),
          ...(budgetBytes != null ? { budget_bytes: budgetBytes } : {}),
        }
      : undefined;

  return {
    facts: {
      active_latest: await count(db, `SELECT COUNT(*) as count FROM facts WHERE ${CURRENT}`),
      total: await count(db, `SELECT COUNT(*) as count FROM facts`),
    },
    entities: await count(db, `SELECT COUNT(*) as count FROM entities`),
    domains: await count(db, `SELECT COUNT(*) as count FROM domains`),
    consolidations: await count(db, `SELECT COUNT(*) as count FROM consolidations`),
    domain_distribution: domainDistribution,
    embeddings: embeddingCoverage,
    events: { ...eventVolume, reclaimable },
    store,
    extract: {
      watermark: await extractWatermark(db),
      unextracted_events: await unexaminedEventCount(db),
    },
    pending_facts: await count(
      db,
      `SELECT COUNT(*) as count FROM session_facts WHERE consolidation_id IS NULL`,
    ),
    intelligence: rollupRuns(await listIntelligenceRuns(db)),
    ...(await tokenBudgetStats(db)),
  };
}

async function tokenBudgetStats(
  db: Db,
): Promise<{ token_budget?: TokenBudgetReport }> {
  const parsed = getBoundTokenBudget(db);
  if (!parsed) return {};
  const runs = await loadRunsForBudget(
    (since) => listIntelligenceRunsSince(db, since),
    parsed,
  );
  return { token_budget: evaluateTokenBudget(runs, parsed) };
}
