/**
 * Related graduated facts for D→I extract.
 *
 * Dumping every active fact into extract is "everything in context". This
 * retrieves a small related set via the same hybrid search the read path
 * uses, capped. Cue, not veto — contradiction is still extracted.
 */

import type { Db } from "../db/connection.js";
import type { Fact, SessionEvent } from "../types/data.js";
import { hybridSearch } from "../search/index.js";
import { EXTRACT_RELATED_K_CAP } from "./extract-prompt.js";

/** Tokens long enough to be a search cue. Not a stopword list. */
const MIN_TOKEN = 4;

function tokensFromEvents(events: SessionEvent[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of events) {
    const raw = event.content ?? "";
    for (const part of raw.split(/\s+/)) {
      const token = part.replace(/[^a-zA-Z0-9]/g, "");
      if (token.length < MIN_TOKEN) continue;
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * Bounded related-K for this candidate batch. Empty events or an empty
 * store yield []. Never the whole `facts` table.
 */
export function relatedFactsForExtract(
  db: Db,
  events: SessionEvent[],
  cap: number = EXTRACT_RELATED_K_CAP,
): Fact[] {
  if (cap <= 0) return [];
  const tokens = tokensFromEvents(events, cap);
  if (tokens.length === 0) return [];

  const seen = new Map<string, { fact: Fact; score: number }>();
  for (const token of tokens) {
    const response = hybridSearch(db, token, { limit: cap });
    for (const row of response.results) {
      const prev = seen.get(row.fact.id);
      if (!prev || row.score > prev.score) {
        seen.set(row.fact.id, { fact: row.fact, score: row.score });
      }
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((row) => row.fact);
}
