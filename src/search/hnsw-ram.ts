/**
 * Process-local HNSW catalogue of `fact_embeddings` for SQLite.
 *
 * BLOBs stay the source of truth. The graph lives in RAM, keyed by database
 * handle + model + dimension, rebuilt from BLOBs when missing or stale, and
 * gone when the process exits. Two data dirs do not share an index.
 */

import type { Db } from "../db/connection.js";
import { countEmbeddings, getEmbeddings, type NewEmbedding } from "../db/embeddings.js";
import { HnswGraph } from "./hnsw-graph.js";

export interface RamHnswHit {
  id: string;
  score: number;
}

const graphs = new WeakMap<Db, Map<string, HnswGraph>>();

let engineAvailable = true;
let failNextEnsure = false;

function cacheKey(model: string, dimensions: number): string {
  return `${model}\0${dimensions}`;
}

/** Production is always true. Tests can force a missing engine. */
export function inProcessEnginePresent(): boolean {
  return engineAvailable;
}

export function setInProcessEngineAvailableForTest(available: boolean): void {
  engineAvailable = available;
}

export function resetInProcessEngineForTest(): void {
  engineAvailable = true;
  failNextEnsure = false;
}

export function failNextRamHnswEnsureForTest(): void {
  failNextEnsure = true;
}

export function dropRamHnsw(
  db: Db,
  model?: string,
  dimensions?: number,
): void {
  if (model === undefined || dimensions === undefined) {
    graphs.delete(db);
    return;
  }
  graphs.get(db)?.delete(cacheKey(model, dimensions));
}

function bucket(db: Db): Map<string, HnswGraph> {
  let map = graphs.get(db);
  if (!map) {
    map = new Map();
    graphs.set(db, map);
  }
  return map;
}

export async function ensureRamHnsw(
  db: Db,
  model: string,
  dimensions: number,
): Promise<HnswGraph> {
  if (!inProcessEnginePresent()) {
    throw new Error("in-process HNSW engine is not available");
  }
  if (failNextEnsure) {
    failNextEnsure = false;
    throw new Error("injected HNSW ensure failure");
  }
  const k = cacheKey(model, dimensions);
  const n = await countEmbeddings(db, model, dimensions);
  const existing = bucket(db).get(k);
  if (existing && existing.size === n && existing.model === model && existing.dimensions === dimensions) {
    return existing;
  }
  const g = new HnswGraph(model, dimensions);
  const stored = await getEmbeddings(db, model, dimensions);
  for (const row of stored) {
    g.add(row.fact_id, row.vector);
  }
  bucket(db).set(k, g);
  return g;
}

/**
 * Add into an already-built graph. No-op when there is no graph (do not build
 * at insert time — search builds on demand). A replace of an existing id
 * drops the graph so the next search rebuilds from BLOBs.
 */
export function syncRamHnsw(
  db: Db,
  embeddings: NewEmbedding[],
  model: string,
  dimensions: number,
): void {
  if (embeddings.length === 0) return;
  const g = bucket(db).get(cacheKey(model, dimensions));
  if (!g) return;
  if (g.model !== model || g.dimensions !== dimensions) {
    dropRamHnsw(db, model, dimensions);
    return;
  }
  for (const e of embeddings) {
    if (g.has(e.fact_id) || e.vector.length !== dimensions) {
      dropRamHnsw(db, model, dimensions);
      return;
    }
  }
  for (const e of embeddings) {
    g.add(e.fact_id, e.vector);
  }
}

export function ramHnswSearchHits(
  graph: HnswGraph,
  queryVector: Float32Array,
  limit: number,
): RamHnswHit[] {
  return graph.search(queryVector, limit);
}
