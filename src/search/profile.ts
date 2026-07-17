/**
 * The user's identity facts — one definition, shared by every surface that
 * claims to return "the profile".
 *
 * There were two. `get_profile` ran `structuredSearch(db, { domain: "profile" })`,
 * which defaults to 20 and orders by `created_at DESC`; `memory://profile`
 * fetched 200 and sorted by importance. So the tool returned the 20 *newest*
 * profile facts and never consulted importance — and identity facts are the
 * earliest captured and the most important. Past 20 profile facts, the tool
 * whose description promises "core identity — name, demographics" silently
 * dropped the user's name while the resource still showed it.
 *
 * Ranked by importance because that is what the spec asks for: `memory://profile`
 * is specified as "user identity facts (high importance, is_latest=1)". Recency
 * is the wrong axis for identity — a name does not become less true for being
 * old, and a fact captured today is not more who you are.
 *
 * Known limitation, deliberately left: this still selects on `domain = 'profile'`,
 * which is an exact match against a label a stochastic classifier assigned — the
 * cue/encoding mismatch that `hybridSearch` was fixed to stop doing. A fact
 * misfiled into `general` is invisible here. The fix is a subject anchor rather
 * than a topical folder ("profile" is not a topic; it means "this fact is about
 * the user"), which needs the entity model to carry a subject. Tracked in
 * docs/design/data-model.md § Domains. This function exists so that when that
 * lands, there is one place to change.
 */

import type { Db } from "../db/connection.js";
import type { Fact } from "../types/data.js";
import { structuredSearch } from "./index.js";

/**
 * How many profile facts to consider before ranking.
 *
 * Deliberately far above any plausible profile size: the point is to rank the
 * whole set by importance, not to rank an arbitrary 20 of it. Under-fetching
 * here is what caused the bug this module exists to fix — it is cheap against a
 * local index and expensive to get wrong.
 */
const CANDIDATE_LIMIT = 200;

/** The user's identity facts, most important first. */
export function profileFacts(db: Db, limit: number = CANDIDATE_LIMIT): Fact[] {
  return structuredSearch(db, { domain: "profile", limit: CANDIDATE_LIMIT })
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit);
}
