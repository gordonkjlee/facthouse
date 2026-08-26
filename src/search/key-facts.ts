/**
 * The most important facts this store currently holds — regardless of domain.
 *
 * This replaces `profileFacts`, which selected `domain = 'profile'`. On a general
 * engine that was the last domain-name hardcoded into retrieval, and it broke the
 * moment a store used a different vocabulary: a corporate store has no `profile`
 * domain, so its bootstrap view was empty.
 *
 * "The most important facts" is universal where "the profile domain" is not.
 * Importance is calibrated per-domain from the store's own config (medical 0.9
 * and profile 0.85 in a personal store; incidents 0.95 and clients 0.7 in a
 * corporate one), so the top of this list is whatever matters most *to this
 * store* — identity and allergies for a person, outages and contracts for a
 * company — with no engine-side opinion about which.
 *
 * This is the "precomputed identity digest" the read tools and the briefing want:
 * a cue-less, always-available summary ranked by what matters, not a query.
 *
 * Degradation is honest: a store with no configured importance and no LLM leaves
 * every fact at the 0.5 baseline, and this falls back to recency within that tie.
 * That is worse than a calibrated store, but it is never empty and never wrong —
 * unlike a domain query against a vocabulary the store does not use.
 */

import type { Db } from "../db/connection.js";
import type { Fact } from "../types/data.js";

/** The predicate for a currently-true fact — identical to the one in stats.ts. */
const CURRENT = `status = 'active' AND is_latest = 1
  AND (valid_until IS NULL OR valid_until > datetime('now'))`;

/**
 * The store's highest-importance current facts, most important first.
 *
 * Ties on importance break by recency, so among equally-weighted facts the
 * freshest lead — which is also the sole ordering when nothing has calibrated
 * importance.
 */
export async function keyFacts(db: Db, limit: number = 200): Promise<Fact[]> {
  const rows = (await db
    .prepare(
      `SELECT * FROM facts
       WHERE ${CURRENT}
       ORDER BY importance DESC, created_at DESC
       LIMIT ?`,
    )
    .all(limit)) as Array<Omit<Fact, "is_latest"> & { is_latest: number }>;

  return rows.map((row) => ({ ...row, is_latest: row.is_latest === 1 }));
}
