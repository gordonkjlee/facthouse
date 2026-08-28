import { describe, it, expect } from "vitest";
import { HnswGraph } from "../../src/search/hnsw-graph.js";
import { cosineSimilarity } from "../../src/search/vector.js";

function vec(...xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

function bruteTop(
  query: Float32Array,
  items: Array<{ id: string; v: Float32Array }>,
): string {
  let bestId = items[0]!.id;
  let best = -Infinity;
  for (const item of items) {
    const s = cosineSimilarity(query, item.v);
    if (s > best) {
      best = s;
      bestId = item.id;
    }
  }
  return bestId;
}

describe("HnswGraph", () => {
  it("returns the query vector's own id as the top hit", () => {
    const g = new HnswGraph("m", 4);
    const items = [
      { id: "axis", v: vec(1, 0, 0, 0) },
      { id: "other", v: vec(0, 1, 0, 0) },
      { id: "third", v: vec(0, 0, 1, 0) },
      { id: "fourth", v: vec(0, 0, 0, 1) },
    ];
    for (const item of items) g.add(item.id, item.v);
    const hits = g.search(vec(1, 0, 0, 0), 2);
    expect(hits[0]?.id).toBe("axis");
    expect(hits[0]?.score).toBeCloseTo(1, 5);
  });

  it("matches brute-force top-1 on a distinctive set", () => {
    const g = new HnswGraph("m", 8);
    const items: Array<{ id: string; v: Float32Array }> = [];
    for (let i = 0; i < 24; i++) {
      const v = new Float32Array(8);
      v[i % 8] = 1 + i * 0.01;
      v[(i + 3) % 8] = 0.1;
      items.push({ id: `f${i}`, v });
      g.add(`f${i}`, v);
    }
    const query = items[11]!.v;
    expect(g.search(query, 1)[0]?.id).toBe(bruteTop(query, items));
  });

  it("refuses a different dimension", () => {
    const g = new HnswGraph("m", 2);
    g.add("a", vec(1, 0));
    expect(() => g.add("b", vec(1, 0, 0))).toThrow(/dimensions/);
    expect(() => g.search(vec(1), 1)).toThrow(/dimensions/);
  });

  it("refuses a second add of the same id", () => {
    const g = new HnswGraph("m", 2);
    g.add("a", vec(1, 0));
    expect(() => g.add("a", vec(0, 1))).toThrow(/already holds/);
  });
});
