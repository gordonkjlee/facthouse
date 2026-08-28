/**
 * In-process HNSW over float32 vectors, cosine distance.
 *
 * Pure TypeScript — no native addon, no WASM loader. The graph is RAM-only
 * and rebuildable from `fact_embeddings` BLOBs. Approximate: recall is not
 * exact, but with the construction parameters below a small distinctive set
 * returns the same top hit as a full cosine scan.
 */

const M = 16;
const M_MAX_0 = 32;
const EF_CONSTRUCTION = 64;
const EF_SEARCH = 64;
const ML = 1 / Math.log(M);
const MAX_LEVEL = 16;

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - sim;
}

function copyVector(v: Float32Array): Float32Array {
  const out = new Float32Array(v.length);
  out.set(v);
  return out;
}

interface DistNode {
  i: number;
  d: number;
}

export class HnswGraph {
  readonly model: string;
  readonly dimensions: number;
  private readonly vectors: Float32Array[] = [];
  private readonly ids: string[] = [];
  private readonly idToIndex = new Map<string, number>();
  private readonly levels: number[] = [];
  /** neighbors[node][layer] → neighbour indices */
  private readonly neighbors: number[][][] = [];
  private entryPoint = -1;
  private maxLevel = -1;

  constructor(model: string, dimensions: number) {
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw new Error(`HNSW refuses dimension ${dimensions}`);
    }
    this.model = model;
    this.dimensions = dimensions;
  }

  get size(): number {
    return this.ids.length;
  }

  has(id: string): boolean {
    return this.idToIndex.has(id);
  }

  add(id: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `HNSW vector has ${vector.length} dimensions, index holds ${this.dimensions}`,
      );
    }
    if (this.idToIndex.has(id)) {
      throw new Error(`HNSW already holds ${id}; drop and rebuild rather than mutate`);
    }
    const vec = copyVector(vector);
    const idx = this.vectors.length;
    const level = this.randomLevel();
    this.vectors.push(vec);
    this.ids.push(id);
    this.idToIndex.set(id, idx);
    this.levels.push(level);
    this.neighbors.push(
      Array.from({ length: level + 1 }, () => [] as number[]),
    );

    if (this.entryPoint < 0) {
      this.entryPoint = idx;
      this.maxLevel = level;
      return;
    }

    const distTo = (j: number) => cosineDistance(vec, this.vectors[j]);
    let ep = this.entryPoint;
    for (let lc = this.maxLevel; lc > level; lc--) {
      const nearest = this.searchLayer(distTo, [ep], 1, lc);
      ep = nearest[0] ?? ep;
    }
    const connectUpTo = Math.min(level, this.maxLevel);
    for (let lc = connectUpTo; lc >= 0; lc--) {
      const candidates = this.searchLayer(distTo, [ep], EF_CONSTRUCTION, lc);
      const mMax = lc === 0 ? M_MAX_0 : M;
      const selected = candidates.slice(0, M);
      this.neighbors[idx][lc] = selected.slice();
      for (const n of selected) {
        this.link(n, idx, lc, mMax);
      }
      ep = candidates[0] ?? ep;
    }
    if (level > this.maxLevel) {
      this.entryPoint = idx;
      this.maxLevel = level;
    }
  }

  /**
   * Nearest neighbours as cosine *similarity* (not distance), best first.
   */
  search(query: Float32Array, limit: number): Array<{ id: string; score: number }> {
    if (query.length !== this.dimensions) {
      throw new Error(
        `query vector has ${query.length} dimensions, index holds ${this.dimensions}`,
      );
    }
    if (this.entryPoint < 0 || limit <= 0) return [];
    const distTo = (j: number) => cosineDistance(query, this.vectors[j]);
    let ep = this.entryPoint;
    for (let lc = this.maxLevel; lc > 0; lc--) {
      const nearest = this.searchLayer(distTo, [ep], 1, lc);
      ep = nearest[0] ?? ep;
    }
    const found = this.searchLayer(distTo, [ep], Math.max(EF_SEARCH, limit), 0);
    const top = found.slice(0, limit);
    return top.map((i) => ({
      id: this.ids[i],
      score: 1 - distTo(i),
    }));
  }

  private randomLevel(): number {
    const u = Math.random() || Number.EPSILON;
    return Math.min(MAX_LEVEL, Math.floor(-Math.log(u) * ML));
  }

  private searchLayer(
    dist: (i: number) => number,
    entryPoints: number[],
    ef: number,
    layer: number,
  ): number[] {
    const visited = new Set<number>(entryPoints);
    const cand: DistNode[] = [];
    const w: DistNode[] = [];
    for (const i of entryPoints) {
      if (i < 0 || i >= this.vectors.length) continue;
      const d = dist(i);
      cand.push({ i, d });
      w.push({ i, d });
    }
    if (w.length === 0) return [];

    while (cand.length > 0) {
      cand.sort((a, b) => a.d - b.d);
      const current = cand.shift()!;
      w.sort((a, b) => b.d - a.d);
      const furthest = w[0]!;
      if (current.d > furthest.d) break;
      const neigh = this.neighbors[current.i]?.[layer] ?? [];
      for (const e of neigh) {
        if (visited.has(e)) continue;
        visited.add(e);
        const d = dist(e);
        w.sort((a, b) => b.d - a.d);
        if (d < (w[0]?.d ?? Infinity) || w.length < ef) {
          cand.push({ i: e, d });
          w.push({ i: e, d });
          if (w.length > ef) {
            w.sort((a, b) => b.d - a.d);
            w.shift();
          }
        }
      }
    }
    w.sort((a, b) => a.d - b.d);
    return w.map((n) => n.i);
  }

  private link(from: number, to: number, layer: number, mMax: number): void {
    const list = this.neighbors[from][layer] ?? (this.neighbors[from][layer] = []);
    if (!list.includes(to)) list.push(to);
    if (list.length <= mMax) return;
    const src = this.vectors[from];
    list.sort(
      (a, b) => cosineDistance(src, this.vectors[a]) - cosineDistance(src, this.vectors[b]),
    );
    this.neighbors[from][layer] = list.slice(0, mMax);
  }
}
