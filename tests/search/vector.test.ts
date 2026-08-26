/**
 * Vector storage and the semantic recall path.
 *
 * The failure modes here are silent, which shapes what these assert. A vector
 * compared against one from a different model returns a confident number that
 * means nothing; a truncated BLOB decodes into a plausible-looking vector; a
 * query embedded as a document degrades every result. None of those raise, and
 * none would be caught by a test that merely checked "search returns results".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const dbMod = await import("../../src/db/index.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertFact } = await import("../../src/db/facts.js");
const {
  packVector,
  unpackVector,
  insertEmbeddings,
  getEmbeddings,
  getFactsMissingEmbeddings,
  countEmbeddings,
} = await import("../../src/db/embeddings.js");
const { cosineSimilarity, vectorSearch } = await import("../../src/search/vector.js");
const { hybridSearch } = await import("../../src/search/index.js");

let db: Db;

beforeEach(async () => {
  db = dbMod.openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await dbMod.closeDatabase(db);
});

const vec = (...xs: number[]) => Float32Array.from(xs);

async function addFact(content: string, domain = "general") {
  return await insertFact(db, { content, domain, source_type: "explicit" });
}

describe("vector serialisation", () => {
  it("round-trips exactly", () => {
    // Float32 is exact for these, so equality is the right assertion — an
    // approximate check would hide an endianness or offset bug.
    const original = vec(1, -1, 0.5, -0.25, 0);
    expect(Array.from(unpackVector(packVector(original)))).toEqual(
      Array.from(original),
    );
  });

  it("preserves negative zero and denormals", () => {
    // The values a naive implementation quietly flattens.
    //
    // Compared against what the Float32Array actually holds, not against the
    // decimal literals: 1.4e-45 is a double that *rounds* to the smallest
    // float32 denormal but is not equal to it, so asserting on the literal
    // would fail a correct round-trip. What matters is that the bytes survive.
    const original = vec(-0, 1.4e-45, -1.4e-45);
    const back = unpackVector(packVector(original));
    expect(Object.is(back[0], -0)).toBe(true);
    expect(back[1]).toBe(original[1]);
    expect(back[2]).toBe(original[2]);
    // ...and that the denormal is genuinely non-zero, so this is not passing
    // by both sides having been flushed to zero.
    expect(original[1]).toBeGreaterThan(0);
  });

  it("does not alias a shared buffer", () => {
    // A typed array can be a view onto a larger buffer. Packing by handing over
    // `.buffer` would store the neighbouring bytes too.
    const shared = new Float32Array([9, 9, 1, 2, 3]);
    const view = shared.subarray(2);
    expect(Array.from(unpackVector(packVector(view)))).toEqual([1, 2, 3]);
  });

  it("rejects a blob that is not a whole number of floats", () => {
    // Truncation would otherwise decode into a shorter, plausible vector.
    expect(() => unpackVector(Buffer.alloc(7))).toThrow(/multiple of 4/);
  });
});

describe("cosineSimilarity", () => {
  it("scores identical, orthogonal and opposite vectors", () => {
    expect(cosineSimilarity(vec(1, 0), vec(1, 0))).toBeCloseTo(1, 10);
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 10);
    expect(cosineSimilarity(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1, 10);
  });

  it("matches a hand-computed non-trivial case", () => {
    // (1,2,3)·(4,5,6) = 32; |a| = sqrt(14), |b| = sqrt(77).
    // A sign or index error survives the three cases above but not this one.
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity(vec(1, 2, 3), vec(4, 5, 6))).toBeCloseTo(expected, 10);
  });

  it("is unaffected by magnitude", () => {
    // Guards the normalisation: without it this is a dot product, and longer
    // vectors would outrank better-aligned ones.
    expect(cosineSimilarity(vec(1, 1), vec(100, 100))).toBeCloseTo(1, 10);
  });

  it("returns 0 for a zero vector rather than NaN", () => {
    // NaN would sort unpredictably and poison the ranking silently.
    expect(cosineSimilarity(vec(0, 0), vec(1, 1))).toBe(0);
  });

  it("refuses to compare different lengths", () => {
    expect(() => cosineSimilarity(vec(1, 2), vec(1, 2, 3))).toThrow(/equal lengths/);
  });
});

describe("model and dimension isolation", () => {
  /**
   * The constraint the whole design exists to enforce. Vectors from different
   * models occupy different spaces: comparing them yields a number, that number
   * is meaningless, and nothing anywhere raises. A store that silently mixes
   * them returns confident nonsense.
   */
  it("never returns a vector from a different model", async () => {
    const a = await addFact("fact under model A");
    const b = await addFact("fact under model B");
    await insertEmbeddings(db, [{ fact_id: a.id, vector: vec(1, 0) }], "model-a", 2);
    await insertEmbeddings(db, [{ fact_id: b.id, vector: vec(1, 0) }], "model-b", 2);

    const hits = await vectorSearch(db, vec(1, 0), "model-a", 2, 10);

    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(a.id);
  });

  it("never returns a vector of a different dimension", async () => {
    // The subtler half: same model, re-embedded at a different truncation.
    // A 512-dim query against 256-dim vectors is not a comparison at all.
    const a = await addFact("stored at 2 dimensions");
    const b = await addFact("stored at 3 dimensions");
    await insertEmbeddings(db, [{ fact_id: a.id, vector: vec(1, 0) }], "same-model", 2);
    await insertEmbeddings(db, [{ fact_id: b.id, vector: vec(1, 0, 0) }], "same-model", 3);

    const hits = await vectorSearch(db, vec(1, 0), "same-model", 2, 10);

    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(a.id);
  });

  it("rejects a query vector that does not match the store's dimension", async () => {
    // Fails loudly rather than comparing a prefix, which would "work".
    const f = await addFact("anything");
    await insertEmbeddings(db, [{ fact_id: f.id, vector: vec(1, 0) }], "m", 2);
    await expect(vectorSearch(db, vec(1, 0, 0), "m", 2, 10)).rejects.toThrow(/dimensions/);
  });

  it("refuses to store a vector whose length contradicts its declared dimension", async () => {
    const f = await addFact("anything");
    await expect(
      insertEmbeddings(db, [{ fact_id: f.id, vector: vec(1, 0, 0) }], "m", 2),
    ).rejects.toThrow(/dimensions/);
  });
});

describe("vectorSearch", () => {
  it("ranks by similarity, most similar first", async () => {
    // Three vectors deliberately within the relative cutoff of each other, so
    // this test observes *ordering* only. Exclusion is the cutoff's job and is
    // covered separately — a fixture spread wide enough to be dropped would
    // conflate the two and pass for the wrong reason.
    const near = await addFact("near");
    const mid = await addFact("mid");
    const farther = await addFact("farther");
    await insertEmbeddings(
      db,
      [
        // Inserted out of order so a stable sort cannot fake the result.
        { fact_id: farther.id, vector: vec(0.9, 0.436) },  // cos ≈ 0.90
        { fact_id: near.id, vector: vec(1, 0) },           // cos = 1.00
        { fact_id: mid.id, vector: vec(0.98, 0.199) },     // cos ≈ 0.98
      ],
      "m",
      2,
    );

    expect((await vectorSearch(db, vec(1, 0), "m", 2, 10)).map((f) => f.id)).toEqual([
      near.id,
      mid.id,
      farther.id,
    ]);
  });

  it("returns nothing when the store holds no vectors for this model", async () => {
    await addFact("unembedded");
    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10)).toEqual([]);
  });

  it("omits a fact that was superseded after being embedded", async () => {
    // An embedding outlives the currency of its fact. Returning it would
    // resurrect superseded knowledge through a path that never checks.
    const f = await addFact("superseded since embedding");
    await insertEmbeddings(db, [{ fact_id: f.id, vector: vec(1, 0) }], "m", 2);
    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10)).toHaveLength(1);

    await db.prepare(`UPDATE facts SET status = 'superseded', is_latest = 0 WHERE id = ?`)
      .run(f.id);

    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10)).toEqual([]);
  });
});

describe("the semantic path ranks rather than gates", () => {
  /**
   * The regression that would silently break every partially-embedded store —
   * which is every store, for as long as it takes the first backfill to run.
   */
  it("still returns a keyword match for a fact with no embedding", async () => {
    const embedded = await addFact("something entirely unrelated");
    const unembedded = await addFact("the user prefers dark roast coffee");
    await insertEmbeddings(db, [{ fact_id: embedded.id, vector: vec(1, 0) }], "m", 2);

    const res = await hybridSearch(db, "coffee", {
      semantic: { vector: vec(1, 0), model: "m", dimensions: 2 },
    });

    expect(res.results.map((r) => r.fact.id)).toContain(unembedded.id);
  });

  it("adds recall where keyword finds nothing", async () => {
    // The product claim in one assertion: a query with no lexical overlap
    // returns nothing today, and returns the right fact with a vector.
    const f = await addFact("the user is allergic to shellfish");
    await insertEmbeddings(db, [{ fact_id: f.id, vector: vec(1, 0) }], "m", 2);

    expect((await hybridSearch(db, "zzzznomatch")).results).toHaveLength(0);

    const withSemantic = await hybridSearch(db, "zzzznomatch", {
      semantic: { vector: vec(1, 0), model: "m", dimensions: 2 },
    });
    expect(withSemantic.results.map((r) => r.fact.id)).toEqual([f.id]);
  });

  it("is inert when no semantic option is passed", async () => {
    // Keyword-only is the shipped default; an embedded store must behave
    // exactly as before until a caller opts in.
    const f = await addFact("the user prefers dark roast coffee");
    await insertEmbeddings(db, [{ fact_id: f.id, vector: vec(1, 0) }], "m", 2);

    expect((await hybridSearch(db, "coffee")).results.map((r) => r.fact.id)).toEqual([f.id]);
    expect((await hybridSearch(db, "zzzznomatch")).results).toEqual([]);
  });
});

describe("the backfill queue", () => {
  /**
   * There is no retry flag and no failure bookkeeping: a fact with no row for
   * the current model *is* the work queue. These pin that property, because it
   * is what makes a failed embedding run cost nothing permanent.
   */
  it("lists facts with no vector for this model", async () => {
    const a = await addFact("embedded");
    const b = await addFact("not embedded");
    await insertEmbeddings(db, [{ fact_id: a.id, vector: vec(1, 0) }], "m", 2);

    const pending = await getFactsMissingEmbeddings(db, "m", 2, 100);
    expect(pending.map((f) => f.id)).toEqual([b.id]);
  });

  it("enqueues the whole store when the model changes", async () => {
    // A model change is not a special case with its own migration — it is the
    // ordinary "no row for this model" condition, applied to everything.
    const a = await addFact("one");
    const b = await addFact("two");
    await insertEmbeddings(
      db,
      [{ fact_id: a.id, vector: vec(1, 0) }, { fact_id: b.id, vector: vec(0, 1) }],
      "old-model",
      2,
    );

    expect(await getFactsMissingEmbeddings(db, "old-model", 2, 100)).toHaveLength(0);
    expect(await getFactsMissingEmbeddings(db, "new-model", 2, 100)).toHaveLength(2);
  });

  it("excludes superseded facts", async () => {
    const f = await addFact("superseded");
    await db.prepare(`UPDATE facts SET status = 'superseded', is_latest = 0 WHERE id = ?`)
      .run(f.id);
    expect(await getFactsMissingEmbeddings(db, "m", 2, 100)).toEqual([]);
  });

  it("re-embedding replaces rather than accumulating", async () => {
    const f = await addFact("re-embedded");
    await insertEmbeddings(db, [{ fact_id: f.id, vector: vec(1, 0) }], "m", 2);
    await insertEmbeddings(db, [{ fact_id: f.id, vector: vec(0, 1) }], "m", 2);

    expect(await countEmbeddings(db, "m", 2)).toBe(1);
    expect(Array.from((await getEmbeddings(db, "m", 2))[0].vector)).toEqual([0, 1]);
  });
});

describe("the relative cutoff", () => {
  /**
   * Cosine has no natural zero: every stored vector scores against every query,
   * and unrelated facts land near the model's floor rather than near 0. Without
   * a cut, this path hands back the entire store on every query — which floods
   * an assistant with the whole knowledge base whatever it asked for.
   *
   * The cut is relative because that floor is a property of the model, not of
   * relevance. An absolute threshold would be tuned to one embedding model and
   * silently wrong for the next.
   */
  it("drops hits that are not comparable to the best one", async () => {
    const near = await addFact("clearly relevant");
    const far = await addFact("clearly not");
    await insertEmbeddings(
      db,
      [
        { fact_id: near.id, vector: vec(1, 0) },
        // ~0.6 similarity to (1,0) — well under 85% of 1.0.
        { fact_id: far.id, vector: vec(0.6, 0.8) },
      ],
      "m",
      2,
    );

    expect((await vectorSearch(db, vec(1, 0), "m", 2, 10)).map((f) => f.id)).toEqual([near.id]);
  });

  it("keeps a genuine cluster of comparable hits", async () => {
    // An ambiguous query should return its whole cluster, not an arbitrary one
    // of them — the cut asks "comparable to the best", not "the single best".
    const a = await addFact("one of two equally good answers");
    const b = await addFact("the other");
    await insertEmbeddings(
      db,
      [
        { fact_id: a.id, vector: vec(1, 0) },
        { fact_id: b.id, vector: vec(0.99, 0.14) },
      ],
      "m",
      2,
    );

    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10)).toHaveLength(2);
  });

  it("returns nothing when the best hit is not positively similar", async () => {
    // Every stored vector points away from the query. A negative-cosine "match"
    // is noise, and a ratio of negatives is meaningless.
    const f = await addFact("opposite");
    await insertEmbeddings(db, [{ fact_id: f.id, vector: vec(-1, 0) }], "m", 2);

    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10)).toEqual([]);
  });
});

describe("the cutoff is configurable", () => {
  /**
   * The default was measured against one model, and the value it compensates
   * for — where unrelated facts sit — belongs to the model rather than to
   * relevance. A store on a different provider needs a different ratio, which
   * is the same reason `dimensions` is configurable.
   */
  async function twoHits() {
    const near = await addFact("close");
    const far = await addFact("further");
    await insertEmbeddings(
      db,
      [
        { fact_id: near.id, vector: vec(1, 0) },        // cos = 1.00
        { fact_id: far.id, vector: vec(0.8, 0.6) },     // cos = 0.80
      ],
      "m",
      2,
    );
    return { near, far };
  }

  it("excludes at the default and includes at a looser ratio", async () => {
    const { near, far } = await twoHits();

    // 0.80 < 0.85 of 1.00 — dropped by default.
    expect((await vectorSearch(db, vec(1, 0), "m", 2, 10)).map((f) => f.id)).toEqual([near.id]);

    // A store that wants broader recall says so.
    expect((await vectorSearch(db, vec(1, 0), "m", 2, 10, { minSimilarityRatio: 0.7 })).map((f) => f.id)).toEqual([
      near.id,
      far.id,
    ]);
  });

  it("keeps only the best at a ratio of 1", async () => {
    const { near } = await twoHits();
    expect((await vectorSearch(db, vec(1, 0), "m", 2, 10, { minSimilarityRatio: 1 })).map((f) => f.id)).toEqual([near.id]);
  });

  it("keeps everything positively similar at a ratio of 0", async () => {
    // A meaningful extreme, not a misconfiguration: it hands ranking entirely
    // to the merge.
    await twoHits();
    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10, { minSimilarityRatio: 0 })).toHaveLength(2);
  });

  it("clamps a ratio above 1 rather than silently disabling the path", async () => {
    // Nothing can exceed 100% of the best score, so an unclamped 1.5 would
    // return nothing at all — tightening the knob past its end would look
    // like semantic search had stopped working.
    const { near } = await twoHits();
    expect((await vectorSearch(db, vec(1, 0), "m", 2, 10, { minSimilarityRatio: 1.5 })).map((f) => f.id)).toEqual([near.id]);
  });

  it("clamps a negative ratio", async () => {
    await twoHits();
    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10, { minSimilarityRatio: -3 })).toHaveLength(2);
  });
});

describe("the absolute floor", () => {
  /**
   * The case the ratio provably cannot handle, found by running real queries
   * against a real model rather than by reasoning about the code.
   *
   * A query the store knows nothing about does not score near zero — it scores
   * a tight band of noise. Measured on a seeded store with nomic-embed-text,
   * "quantum physics" scored 0.480 down to 0.419 across four unrelated facts.
   * Every one of those ratios clears 0.85, so the relative cut kept all four
   * and search answered a question it had no answer to.
   */
  async function noiseBand() {
    // Four facts within 13% of each other, none of them a real match — the
    // shape an unrelated query actually produces.
    const ids = await Promise.all(["a", "b", "c", "d"].map((n) => addFact(`fact ${n}`)));
    await insertEmbeddings(
      db,
      [
        { fact_id: ids[0].id, vector: vec(0.48, 0.877) },  // cos ≈ 0.48
        { fact_id: ids[1].id, vector: vec(0.455, 0.89) },  // cos ≈ 0.455
        { fact_id: ids[2].id, vector: vec(0.426, 0.905) }, // cos ≈ 0.426
        { fact_id: ids[3].id, vector: vec(0.419, 0.908) }, // cos ≈ 0.419
      ],
      "m",
      2,
    );
    return ids;
  }

  it("keeps the whole noise band when only the ratio is set", async () => {
    // Not the desired behaviour — the shipped default, asserted so the gap is
    // recorded rather than assumed fixed.
    await noiseBand();
    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10)).toHaveLength(4);
  });

  it("returns nothing when the whole field is below the floor", async () => {
    await noiseBand();
    expect(await vectorSearch(db, vec(1, 0), "m", 2, 10, { minSimilarity: 0.5 })).toEqual([]);
  });

  it("still returns a genuine match above the floor", async () => {
    // The floor must not make the feature silent — the same store, a query
    // that does have an answer.
    const real = await addFact("the real match");
    await noiseBand();
    await insertEmbeddings(db, [{ fact_id: real.id, vector: vec(1, 0) }], "m", 2);

    const hits = await vectorSearch(db, vec(1, 0), "m", 2, 10, { minSimilarity: 0.5 });
    expect(hits.map((f) => f.id)).toEqual([real.id]);
  });

  it("does not let the ratio re-admit what the floor rejected", async () => {
    // Order matters. Applying the ratio to the unfiltered list first would
    // compute "close to the best" from a best that is itself noise, and the
    // floor would then have nothing left to reject.
    const real = await addFact("the real match");
    await noiseBand();
    await insertEmbeddings(db, [{ fact_id: real.id, vector: vec(1, 0) }], "m", 2);

    const hits = await vectorSearch(db, vec(1, 0), "m", 2, 10, {
      minSimilarity: 0.5,
      minSimilarityRatio: 0, // keep everything the floor allows
    });
    expect(hits.map((f) => f.id)).toEqual([real.id]);
  });

  it("is off by default, so an unconfigured store behaves exactly as before", async () => {
    const real = await addFact("the real match");
    await insertEmbeddings(db, [{ fact_id: real.id, vector: vec(1, 0) }], "m", 2);
    expect((await vectorSearch(db, vec(1, 0), "m", 2, 10)).map((f) => f.id)).toEqual([real.id]);
  });
});
