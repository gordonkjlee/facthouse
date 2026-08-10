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
 * How close to the best hit a result must be to count as one.
 *
 * Not a relevance threshold — a *comparability* one. See the reasoning in
 * `vectorSearch`: cosine has no zero, so the only honest question is "is this
 * result in the same league as the best one", and the answer has to be
 * expressed relative to that best.
 */
const RELATIVE_CUTOFF = 0.85;

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
export function vectorSearch(
  db: Db,
  queryVector: Float32Array,
  model: string,
  dimensions: number,
  limit: number,
): Fact[] {
  if (queryVector.length !== dimensions) {
    throw new Error(
      `query vector has ${queryVector.length} dimensions, store holds ${dimensions}`,
    );
  }

  const stored = getEmbeddings(db, model, dimensions);
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
  const best = scored[0]?.score ?? 0;
  const kept =
    best <= 0
      ? [] // Nothing positively similar; a negative-cosine "match" is noise.
      : scored.filter((s) => s.score >= best * RELATIVE_CUTOFF);

  // Hydrate only the winners. The scan touches every vector; it must not also
  // load every fact row.
  const topIds = kept.slice(0, limit).map((s) => s.id);
  const byId = new Map(getFactsByIds(db, topIds).map((f) => [f.id, f]));

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
