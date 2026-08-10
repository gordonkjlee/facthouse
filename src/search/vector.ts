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

  // Hydrate only the winners. The scan touches every vector; it must not also
  // load every fact row.
  const topIds = scored.slice(0, limit).map((s) => s.id);
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
