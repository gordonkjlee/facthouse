import { describe, it, expect } from "vitest";
import { computeRetrievalQuality, temporalScore } from "../../src/search/index.js";
import type { Fact } from "../../src/types/data.js";

// ---------------------------------------------------------------------------
// Retrieval quality signals
// ---------------------------------------------------------------------------

describe("computeRetrievalQuality", () => {
  it("returns zeros for empty results", () => {
    const result = computeRetrievalQuality([], 20);
    expect(result.coverage_estimate).toBe(0);
    expect(result.result_confidence).toBe(0);
    expect(result.suggested_refinement).toMatch(/broader/);
  });

  it("gives a single result moderate-to-high confidence", () => {
    const result = computeRetrievalQuality([{ score: 0.02 }], 20);
    expect(result.result_confidence).toBe(0.7);
    expect(result.coverage_estimate).toBe(0.7);
  });

  it("high confidence when top dominates runner-up", () => {
    // topGap = (1.0 - 0.1) / 1.0 = 0.9 > 0.5 → 0.9
    const result = computeRetrievalQuality(
      [{ score: 1.0 }, { score: 0.1 }, { score: 0.05 }],
      20,
    );
    expect(result.result_confidence).toBe(0.9);
  });

  it("low confidence when top and runner-up are close", () => {
    // topGap = (0.5 - 0.48) / 0.5 = 0.04 — multiple valid candidates
    const result = computeRetrievalQuality(
      [{ score: 0.5 }, { score: 0.48 }, { score: 0.47 }],
      20,
    );
    expect(result.result_confidence).toBe(0.5);
  });

  it("moderate confidence for clear but not dominant lead", () => {
    // topGap = (1.0 - 0.6) / 1.0 = 0.4 — clear lead but not dominant
    const result = computeRetrievalQuality(
      [{ score: 1.0 }, { score: 0.6 }, { score: 0.5 }],
      20,
    );
    expect(result.result_confidence).toBe(0.7);
  });

  it("coverage=0.5 (truncated) when results hit the limit", () => {
    const results = Array.from({ length: 20 }, () => ({ score: 0.02 }));
    const result = computeRetrievalQuality(results, 20);
    expect(result.coverage_estimate).toBe(0.5);
  });

  it("suggests refinement when confidence is low", () => {
    const result = computeRetrievalQuality(
      [{ score: 0.5 }, { score: 0.48 }, { score: 0.47 }],
      20,
    );
    expect(result.suggested_refinement).toMatch(/specific|domain/);
  });

  it("no refinement suggestion when confidence is high", () => {
    const result = computeRetrievalQuality(
      [{ score: 1.0 }, { score: 0.1 }],
      20,
    );
    expect(result.suggested_refinement).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Temporal scoring
// ---------------------------------------------------------------------------

function makeFact(createdAt: string, importance: number): Fact {
  return {
    id: "test-id",
    content: "test",
    domain: "general",
    subdomain: null,
    confidence: 0.7,
    importance,
    source_type: "conversation",
    source_tool: null,
    source_id: null,
    status: "active",
    superseded_by: null,
    is_latest: true,
    created_at: createdAt,
    valid_from: createdAt,
    valid_until: null,
    system_retired_at: null,
    session_id: null,
    capture_context: null,
    access_count: 0,
  };
}

describe("temporalScore", () => {
  it("returns ~1.0 for a fact created now", () => {
    const fact = makeFact(new Date().toISOString(), 1.0);
    const score = temporalScore(fact);
    expect(score).toBeGreaterThan(0.99);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("returns 0.5 for a fact 30 days old at importance 1.0", () => {
    // Formula: 1 / (1 + days / (30 * importance))
    // days=30, importance=1.0 → 1 / (1 + 30/30) = 1/2 = 0.5
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fact = makeFact(thirtyDaysAgo, 1.0);
    const score = temporalScore(fact);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it("low-importance facts decay faster", () => {
    // days=30, importance=0.1 → 1 / (1 + 30/3) = 1/11 ≈ 0.091
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fact = makeFact(thirtyDaysAgo, 0.1);
    const score = temporalScore(fact);
    expect(score).toBeCloseTo(0.091, 2);
  });

  it("high-importance facts decay slower", () => {
    // days=60, importance=1.0 → 1 / (1 + 60/30) = 1/3 ≈ 0.333
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const fact = makeFact(sixtyDaysAgo, 1.0);
    const score = temporalScore(fact);
    expect(score).toBeCloseTo(0.333, 2);
  });

  it("is monotonically decreasing with age", () => {
    const now = new Date().toISOString();
    const tenDays = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const scoreNow = temporalScore(makeFact(now, 0.5));
    const scoreTen = temporalScore(makeFact(tenDays, 0.5));
    const scoreThirty = temporalScore(makeFact(thirtyDays, 0.5));

    expect(scoreNow).toBeGreaterThan(scoreTen);
    expect(scoreTen).toBeGreaterThan(scoreThirty);
  });
});
