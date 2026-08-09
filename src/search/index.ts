/**
 * Search engine — hybrid BM25 + structured + temporal via RRF.
 * Temporal ranking uses a rational decay 1/(1 + t/τ). Wixted & Ebbesen (1991)
 * showed forgetting follows a power function at^(-b) — the rational form used
 * here is a computationally convenient approximation (bounded in (0, 1], finite
 * at t=0, avoids the t^(-b) singularity), not the empirically best-fitting
 * curve. Importance rescales the effective time constant.
 */

import type { Db, SqlParam } from "../db/connection.js";
import type {
  Fact,
  SearchResult,
  SearchResponse,
  PendingFact,
} from "../types/data.js";
import {
  keywordSearch as fts5Search,
  sanitiseFtsQuery,
  getFactsByDomain,
  getFactsByEntity,
} from "../db/facts.js";
import { findEntity, getEntitiesForFacts } from "../db/entities.js";
import { keywordSearchPending } from "../db/session-facts.js";

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
  db: Db,
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
  const params: SqlParam[] = [];

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
      suggested_refinement: "Nothing matched. Try broader or different terms.",
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
      ? "Results are loosely matched. Try more specific terms, or name a domain to prioritise."
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
 * 2. Structured domain search (if a domain is given)
 * 3. RRF merge
 * 4. Temporal decay boost
 * 5. Sort by final score, take top limit (the domain ranks, never gates)
 * 6. Compute retrieval quality signals
 *
 * A domain widens recall and biases ranking — its facts join the merge, so one
 * the keyword path missed can still surface, and a fact in both paths outranks
 * a fact in one. It does NOT filter: a strong match outside the domain still
 * appears, because domain labels are approximate and a gate on one would hide a
 * fact filed under a synonym.
 */
export function hybridSearch(
  db: Db,
  query: string,
  opts?: HybridSearchOpts,
): SearchResponse {
  const limit = opts?.limit ?? 20;
  const domain = opts?.domain;

  // How many candidates each recall path contributes to the merge, before the
  // final cut to `limit`.
  //
  // This must exceed `limit`. A fact only earns a path's RRF credit if it
  // appears in THAT path's results, so fetching exactly `limit` per path starves
  // the merge: an in-domain fact that misses the keyword top-`limit` loses its
  // second list and ranks as though it were out of domain — the domain signal
  // silently stops working at small limits. Measured before this existed: with
  // limit=3 over 8 matching facts, an out-of-domain fact outranked an in-domain
  // one; the same query at limit=8 ordered correctly.
  //
  // Over-fetching is cheap here (tens of rows from a local SQLite index) and is
  // standard for rank-fusion retrieval: merge from a wide pool, then cut.
  const candidatePool = Math.max(limit * 5, 50);

  // 1. FTS5 keyword search (sanitise to prevent FTS5 syntax errors)
  const sanitised = sanitiseFtsQuery(query);
  const ftsResults = sanitised ? fts5Search(db, sanitised, candidatePool) : [];
  const ftsFacts = ftsResults.map((r) => r.fact);

  // 2. Structured domain path (if a domain was named). This is what makes the
  //    domain a ranking signal: its facts join the merge, so a fact in both this
  //    list and the keyword list outranks a fact in only one.
  const searchLists: Array<{ name: string; facts: Fact[] }> = [
    { name: "fts5", facts: ftsFacts },
  ];

  if (domain) {
    // getFactsByDomain already orders by created_at DESC
    const domainFacts = getFactsByDomain(db, domain).slice(0, candidatePool);
    searchLists.push({ name: "domain", facts: domainFacts });
  }

  // 3. Structured entity path: if the query mentions a known entity,
  // add facts linked to that entity as a second RRF signal.
  // No uppercase filter — findEntity canonicalises to lower(trim(name)) so
  // lowercase queries ("who's alex?") match too. Short terms dropped to
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
    searchLists.push({ name: "entity", facts: entityFacts.slice(0, candidatePool) });
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

  // 6. Sort by final score descending, take top limit.
  //
  // A domain deliberately does NOT filter here. It joins the RRF merge as its
  // own list (step 2), which is already what makes it a ranking signal: a fact
  // that both matches the query and sits in the domain appears in two lists and
  // outranks everything; an out-of-domain keyword match appears in one and
  // ranks below it, but still surfaces.
  //
  // That degradation is the point. Domain labels are assigned by a stochastic
  // classifier at consolidation and would have to be matched exactly here, by a
  // different process — a cue/encoding mismatch. A classifier may answer
  // "health" one run and "medical" the next, so an equality gate turns a label
  // that drifted into an empty result set, silently, with no way for the caller
  // to tell "nothing is known" from "it was filed under a synonym". Ranking
  // degrades where a gate fails absolutely.
  //
  // An earlier revision did filter, to honour a tool description that promised
  // "filter to a specific domain". The description was the thing that was wrong.
  // See docs/design/data-model.md § Domains.
  //
  // (upstream DAL queries already filter by status='active' AND is_latest=1)
  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, limit);

  // 7. Build SearchResult objects.
  // access_count column exists in the schema for future ranking boosts but is
  // not incremented here — writing 20 UPDATEs per search for a field the ranker
  // doesn't read is unjustified write amplification. Add the increment back
  // when access_count is wired into the ranker.
  // Entities are attached here rather than left to the caller. The field was
  // hardcoded empty on the reasoning that the tool layer would enrich if it
  // needed to — and no caller ever did, so every consumer of a search result,
  // the CLI renderer and `search_knowledge` alike, saw a fact stripped of the
  // graph it belongs to. An entity graph nothing surfaces is not a feature.
  //
  // One batched query for the whole page, keyed by fact, rather than a lookup
  // per result.
  const entitiesByFact = getEntitiesForFacts(db, topResults.map(({ fact }) => fact.id));

  const results: SearchResult[] = topResults.map(({ fact, score }) => {
    return {
      fact,
      score: Math.round(score * 10000) / 10000,
      entities: entitiesByFact.get(fact.id) ?? [],
      source: null,
    };
  });

  // 8. Unconsolidated facts.
  //
  // capture_fact writes to session_facts; only graduated facts reach the `facts`
  // table above. Without this a fact the assistant was told a minute ago is
  // unfindable until consolidation runs — by default after ten events or at
  // session end — so "I just told you that" silently failed.
  //
  // Returned separately rather than merged into `results`: a pending fact has
  // been through none of the pipeline, so it is neither deduplicated against
  // what is already known nor reconciled with a fact it may contradict. It is
  // real knowledge and must be findable; it is not yet knowledge of the same
  // standing.
  const pending: PendingFact[] = (
    sanitised ? keywordSearchPending(db, sanitised, limit) : []
  ).map((sf) => ({
    id: sf.id,
    content: sf.content,
    source_origin: sf.source_origin,
    domain_hint: sf.domain_hint,
    confidence: sf.confidence,
    created_at: sf.created_at,
    session_id: sf.session_id,
  }));

  // 9. Compute retrieval quality signals.
  // Deliberately computed from graduated results only: these signals describe
  // how well the knowledge base answered, and a pending fact has not been
  // integrated into it yet. Counting it would report coverage the store does
  // not actually have.
  const quality = computeRetrievalQuality(
    topResults.map(({ score }) => ({ score })),
    limit,
  );

  return {
    results,
    pending,
    ...quality,
  };
}
