/**
 * Semantic recall — exact cosine similarity over stored vectors.
 *
 * No ANN index. The store's working set fits in SQLite's page cache at the
 * scale this runs at, and a full scan is then both exact and cheap: the cost is
 * bytes read, not arithmetic. 4,000 facts at 512 dimensions is under 8 MB. The
 * scan stops being the right answer when the vectors stop fitting in cache,
 * which is what `embedding.dimensions` exists to control — halving the
 * dimension doubles the facts that fit in the same budget.
 *
 * This path **ranks; it does not gate**. Its output is one more list in the RRF
 * merge, alongside keyword, domain, and entity. A fact with no embedding is not
 * excluded from search — it simply earns no credit from this list, exactly as a
 * fact outside the queried domain earns none from that one.
 */

import type { Db } from "../db/connection.js";
import type { Fact } from "../types/data.js";
import { getEmbeddings } from "../db/embeddings.js";
import { getFactsByIds } from "../db/facts.js";

/**
 * Default for how close to the best hit a result must be to count as one.
 *
 * Not a relevance threshold — a *comparability* one. See the reasoning in
 * `vectorSearch`: cosine has no zero, so the only honest question is "is this
 * result in the same league as the best one", and that has to be expressed
 * relative to the best.
 *
 * A default rather than a constant, because the floor it compensates for
 * belongs to the embedding model. Measured against `nomic-embed-text`;
 * overridable via `embedding.min_similarity_ratio`.
 *
 * **It cannot detect that nothing is relevant.** Measured on a seeded store:
 * `"food"` scores 0.540 for the right fact against a 0.449 floor, while
 * `"quantum physics"` — about which the store knows nothing — scores 0.480
 * down to 0.419. The second is a tight cluster of noise, and every ratio in it
 * clears 0.85, so the whole store survives. A relative cut separates one clear
 * winner from a cluster; it cannot tell a cluster of good matches from a
 * cluster of nothing. That needs `minSimilarity` below, which needs a number
 * measured against the model in use.
 */
export const DEFAULT_MIN_SIMILARITY_RATIO = 0.85;

/** Tuning for how much of the ranked list survives. */
export interface VectorSearchOpts {
  /**
   * How close to the best hit a result must be, 0–1. Defaults to
   * {@link DEFAULT_MIN_SIMILARITY_RATIO}.
   */
  minSimilarityRatio?: number;
  /**
   * Absolute cosine floor, below which a hit is not a hit however well it
   * compares to its neighbours.
   *
   * Off by default, because the useful value is a property of the embedding
   * model and no single number is right for the two this ships with — the same
   * reason the ratio is configurable, one step further. A default guessed from
   * one model would be a constant silently applied to models it was never
   * measured against.
   *
   * To find yours: embed a query your store genuinely knows nothing about and
   * read the top score. Anything at or below it is noise.
   */
  minSimilarity?: number;
}

/**
 * Cosine similarity of two equal-length vectors.
 *
 * Normalises rather than assuming unit vectors. Most providers return
 * normalised output and the dot product would be equivalent — but truncated
 * vectors are not unit-length unless renormalised, and a provider that changes
 * its convention would otherwise silently turn this into a magnitude
 * comparison. The extra square roots are irrelevant next to the memory read.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine similarity needs equal lengths, got ${a.length} and ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Facts ranked by similarity to a query vector, most similar first.
 *
 * Returns `Fact[]` — the shape `rrfMerge` consumes — so the semantic path joins
 * the existing merge without changing it.
 *
 * `model` and `dimensions` are required, not optional. Vectors from different
 * models occupy different spaces, and comparing across them produces a
 * confident number that means nothing, with no error raised anywhere. Filtering
 * happens in SQL, so a store still holding a previous model's vectors never
 * materialises them.
 */
export async function vectorSearch(
  db: Db,
  queryVector: Float32Array,
  model: string,
  dimensions: number,
  limit: number,
  opts: VectorSearchOpts = {},
  /**
   * ISO 8601 instant. When set, hydrate facts the system believed at that
   * instant rather than only currently-true rows. Already parsed.
   */
  asOfSystemTime?: string,
): Promise<Fact[]> {
  if (queryVector.length !== dimensions) {
    throw new Error(
      `query vector has ${queryVector.length} dimensions, store holds ${dimensions}`,
    );
  }

  const stored = await getEmbeddings(db, model, dimensions);
  if (stored.length === 0) return [];

  const scored: Array<{ id: string; score: number }> = [];
  for (const row of stored) {
    scored.push({ id: row.fact_id, score: cosineSimilarity(queryVector, row.vector) });
  }
  scored.sort((a, b) => b.score - a.score);

  // Keep only hits close to the best one.
  //
  // Cosine similarity has no natural zero: every stored vector scores against
  // every query, and unrelated facts still land around 0.45 rather than near 0.
  // Without a cut, this path returns the entire store on every query — which
  // makes "nothing is known about that" unreportable, and floods an assistant
  // with the whole knowledge base whatever it asked.
  //
  // The cut is relative rather than absolute because the floor is a property of
  // the model, not of relevance: an absolute threshold would be a constant
  // tuned to one embedding model and silently wrong for the next. A ratio
  // adapts, and asks only that a result be comparable to the best result — the
  // question cosine can actually answer.
  //
  // Measured on the demo store: "food" scores 0.582 for the shellfish fact and
  // 0.482 for the next, a ratio of 0.83; "dark mode" scores 0.729 then 0.432,
  // a ratio of 0.59. A genuinely ambiguous query clusters near 1.0 and keeps
  // its whole cluster, which is the intended behaviour.
  //
  // The ratio cannot report that nothing is relevant — see the constant above.
  // `minSimilarity` is the cut that can, and it is applied first: a store that
  // sets it is asking for silence on queries it has no answer to, and the ratio
  // must not then re-admit the best of a bad field.
  const ratio = Math.min(1, Math.max(0, opts.minSimilarityRatio ?? DEFAULT_MIN_SIMILARITY_RATIO));
  const floor = opts.minSimilarity ?? 0;
  const above = scored.filter((s) => s.score >= floor);
  const best = above[0]?.score ?? 0;
  const kept =
    best <= 0
      ? [] // Nothing positively similar; a negative-cosine "match" is noise.
      : above.filter((s) => s.score >= best * ratio);

  // Hydrate only the winners. The scan touches every vector; it must not also
  // load every fact row.
  const topIds = kept.slice(0, limit).map((s) => s.id);
  const byId = new Map(
    (await getFactsByIds(
      db,
      topIds,
      asOfSystemTime ? { asOfSystemTime } : undefined,
    )).map((f) => [f.id, f]),
  );

  // Re-project through the ranked id list so similarity order survives, and
  // drop any fact the id lookup did not return — an embedding can outlive the
  // currency of its fact (superseded between the write and this read).
  const out: Fact[] = [];
  for (const id of topIds) {
    const fact = byId.get(id);
    if (fact) out.push(fact);
  }
  return out;
}
