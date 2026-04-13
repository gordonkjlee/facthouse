/**
 * Search engine — hybrid BM25 + structured + temporal via RRF.
 * Temporal ranking uses a rational decay 1/(1 + t/τ). Wixted & Ebbesen (1991)
 * showed forgetting follows a power function at^(-b) — the rational form used
 * here is a computationally convenient approximation (bounded in (0, 1], finite
 * at t=0, avoids the t^(-b) singularity), not the empirically best-fitting
 * curve. Importance rescales the effective time constant.
 */

import type Database from "better-sqlite3";
import type { Fact, SearchResult, SearchResponse } from "../types/data.js";
import {
  keywordSearch as fts5Search,
  sanitiseFtsQuery,
  getFactsByDomain,
  getFactsByEntity,
} from "../db/facts.js";
import { findEntity } from "../db/entities.js";

// ---------------------------------------------------------------------------
// Structured search
// ---------------------------------------------------------------------------

export interface StructuredFilters {
  domain?: string;
  subdomain?: string;
  entity_id?: string;
  status?: string;
  is_latest?: boolean;
  limit?: number;
}

/**
 * Query facts via structured filters — domain, subdomain, entity, status.
 * Defaults to active + is_latest = true.
 */
export function structuredSearch(
  db: Database.Database,
  filters: StructuredFilters,
): Fact[] {
  const limit = filters.limit ?? 20;

  // Entity-based path
  if (filters.entity_id) {
    const facts = getFactsByEntity(db, filters.entity_id);
    // getFactsByEntity already filters active + is_latest; apply limit
    return facts.slice(0, limit);
  }

  // Domain-based path
  if (filters.domain) {
    const facts = getFactsByDomain(db, filters.domain, filters.subdomain);
    return facts.slice(0, limit);
  }

  // Fallback: query facts table directly with provided filters
  const conditions: string[] = [];
  const params: unknown[] = [];

  const status = filters.status ?? "active";
  conditions.push("status = ?");
  params.push(status);

  const isLatest = filters.is_latest ?? true;
  conditions.push("is_latest = ?");
  params.push(isLatest ? 1 : 0);

  // Only apply subdomain filter when domain is also specified — subdomains
  // are not globally unique ("beverages" in preferences vs medical).
  if (filters.subdomain && filters.domain) {
    conditions.push("subdomain = ?");
    params.push(filters.subdomain);
  }

  // Defence-in-depth: exclude facts whose validity window has closed,
  // matching getFactsByDomain/getFactsByEntity/keywordSearch in facts.ts.
  conditions.push("(valid_until IS NULL OR valid_until > datetime('now'))");

  const sql = `SELECT * FROM facts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<
    Omit<Fact, "is_latest"> & { is_latest: number }
  >;

  return rows.map((row) => ({ ...row, is_latest: row.is_latest === 1 }));
}

// ---------------------------------------------------------------------------
// RRF merge
// ---------------------------------------------------------------------------

const RRF_K = 60;

interface RankedFact {
  fact: Fact;
  rrfScore: number;
  /** Track which search paths contributed to this result. */
  paths: Set<string>;
}

/**
 * Merge multiple ranked lists via Reciprocal Rank Fusion.
 * score = sum(1 / (k + rank_i)) for each path that returns the fact.
 */
function rrfMerge(
  lists: Array<{ name: string; facts: Fact[] }>,
): Map<string, RankedFact> {
  const merged = new Map<string, RankedFact>();

  for (const list of lists) {
    for (let rank = 0; rank < list.facts.length; rank++) {
      const fact = list.facts[rank];
      const contribution = 1 / (RRF_K + rank);

      const existing = merged.get(fact.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.paths.add(list.name);
      } else {
        merged.set(fact.id, {
          fact,
          rrfScore: contribution,
          paths: new Set([list.name]),
        });
      }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Temporal ranking
// ---------------------------------------------------------------------------

/**
 * Compute temporal decay score. More recent facts score higher, modulated
 * by importance — important facts decay more slowly.
 *
 *   temporal_score = 1 / (1 + days_since / (30 * importance))
 */
export function temporalScore(fact: Fact): number {
  const anchorMs = new Date(fact.valid_from ?? fact.created_at).getTime();
  const nowMs = Date.now();
  const daysSince = Math.max(0, (nowMs - anchorMs) / (1000 * 60 * 60 * 24));
  // Floor at 0.1: importance=0 gives τ=0 → instant decay (score=0), meaning the
  // fact fully vanishes from temporal ranking. The floor ensures even low-importance
  // facts retain a ~3-day effective half-life rather than becoming invisible.
  const importance = Math.max(fact.importance, 0.1);
  return 1 / (1 + daysSince / (30 * importance));
}

// ---------------------------------------------------------------------------
// Retrieval quality heuristics
// ---------------------------------------------------------------------------

interface RetrievalQualitySignals {
  coverage_estimate: number;
  result_confidence: number;
  suggested_refinement: string | null;
}

/** Compute retrieval quality signals from a scored result set.
 *  @precondition results must be sorted by score descending (results[0] is the
 *  top hit). The caller (hybridSearch) is responsible for sorting. */
export function computeRetrievalQuality(
  results: Array<{ score: number }>,
  limit: number,
): RetrievalQualitySignals {
  if (results.length === 0) {
    return {
      coverage_estimate: 0,
      result_confidence: 0,
      suggested_refinement: "Try broader terms or remove domain filter.",
    };
  }

  // Coverage: truncated result set = 0.5, otherwise 0.7.
  // The results.length === 0 case is handled by the early return above.
  const coverage_estimate = results.length >= limit ? 0.5 : 0.7;

  // Confidence: based on result count and top-vs-runner-up gap
  // (not top-vs-average, which penalises uniformly-high-quality result sets).
  let result_confidence: number;
  if (results.length === 1) {
    // Single definitive match — moderate-to-high confidence
    result_confidence = 0.7;
  } else {
    const scores = results.map((r) => r.score);
    const topScore = scores[0];
    const runnerUp = scores[1];
    // How much better is the winner than the closest competitor?
    const topGap = topScore > 0 ? (topScore - runnerUp) / topScore : 0;

    if (topGap > 0.5) {
      // Clear winner — high confidence in ranking
      result_confidence = 0.9;
    } else if (topGap > 0.2) {
      // Moderate lead over runner-up
      result_confidence = 0.7;
    } else {
      // Top and runner-up are close — multiple valid candidates
      result_confidence = 0.5;
    }
  }
  result_confidence = Math.round(result_confidence * 100) / 100;

  const suggested_refinement =
    result_confidence <= 0.5
      ? "Results are loosely matched. Try more specific terms or add a domain filter."
      : null;

  return { coverage_estimate, result_confidence, suggested_refinement };
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

export interface HybridSearchOpts {
  domain?: string;
  limit?: number;
}

/**
 * Hybrid search: FTS5 keyword + structured domain, merged via RRF with
 * temporal decay boosting.
 *
 * Steps:
 * 1. FTS5 keyword search
 * 2. Structured domain search (if domain filter provided)
 * 3. RRF merge
 * 4. Temporal decay boost
 * 5. Sort by final score, take top limit
 * 6. Compute retrieval quality signals
 */
export function hybridSearch(
  db: Database.Database,
  query: string,
  opts?: HybridSearchOpts,
): SearchResponse {
  const limit = opts?.limit ?? 20;
  const domain = opts?.domain;

  // 1. FTS5 keyword search (sanitise to prevent FTS5 syntax errors)
  const sanitised = sanitiseFtsQuery(query);
  const ftsResults = sanitised ? fts5Search(db, sanitised, limit) : [];
  const ftsFacts = ftsResults.map((r) => r.fact);

  // 2. Structured domain search (if domain filter provided)
  const searchLists: Array<{ name: string; facts: Fact[] }> = [
    { name: "fts5", facts: ftsFacts },
  ];

  if (domain) {
    // getFactsByDomain already orders by created_at DESC
    const domainFacts = getFactsByDomain(db, domain).slice(0, limit);
    searchLists.push({ name: "domain", facts: domainFacts });
  }

  // 3. Structured entity path: if the query mentions a known entity,
  // add facts linked to that entity as a second RRF signal.
  // No uppercase filter — findEntity canonicalises to lower(trim(name)) so
  // lowercase queries ("who's gordon?") match too. Short terms dropped to
  // avoid noisy lookups on pronouns/articles; first 5 terms cap work for
  // pathological long queries.
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 5);
  const entityFacts: Fact[] = [];
  const seenEntityFactIds = new Set<string>();
  for (const term of terms) {
    const entity = findEntity(db, term);
    if (entity) {
      for (const fact of getFactsByEntity(db, entity.id)) {
        if (!seenEntityFactIds.has(fact.id)) {
          seenEntityFactIds.add(fact.id);
          entityFacts.push(fact);
        }
      }
    }
  }
  if (entityFacts.length > 0) {
    searchLists.push({ name: "entity", facts: entityFacts.slice(0, limit) });
  }

  // 4. RRF merge
  const merged = rrfMerge(searchLists);

  // 5. Apply temporal ranking boost
  const scored: Array<{ fact: Fact; score: number }> = [];
  for (const ranked of merged.values()) {
    const tScore = temporalScore(ranked.fact);
    const finalScore = ranked.rrfScore * (1 + 0.3 * tScore);
    scored.push({ fact: ranked.fact, score: finalScore });
  }

  // 6. Sort by final score descending, take top limit
  // (upstream DAL queries already filter by status='active' AND is_latest=1)
  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, limit);

  // 7. Build SearchResult objects.
  // access_count column exists in the schema for future ranking boosts but is
  // not incremented here — writing 20 UPDATEs per search for a field the ranker
  // doesn't read is unjustified write amplification. Add the increment back
  // when access_count is wired into the ranker.
  const results: SearchResult[] = topResults.map(({ fact, score }) => {
    return {
      fact,
      score: Math.round(score * 10000) / 10000,
      entities: [], // entity enrichment happens at tool layer if needed
      source: null,
    };
  });

  // 8. Compute retrieval quality signals
  const quality = computeRetrievalQuality(
    topResults.map(({ score }) => ({ score })),
    limit,
  );

  return {
    results,
    ...quality,
  };
}
