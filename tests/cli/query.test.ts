/**
 * search / stats CLI rendering.
 *
 * The formatters are pure, so they are tested directly against synthetic
 * payloads; the dispatch, flags, and exit codes are covered by spawning the
 * real binary in tests/integration/cli-entry.test.ts.
 */

import { describe, it, expect } from "vitest";
import type { SearchResponse } from "../../src/types/data.js";
import type { KnowledgeStats } from "../../src/db/stats.js";

const { formatSearch, formatStats } = await import("../../src/cli/query.js");

function result(content: string, domain = "preferences", subdomain: string | null = "food") {
  return {
    fact: {
      content,
      domain,
      subdomain,
      confidence: 0.9,
    },
    score: 0.1234,
    entities: [],
    source: null,
  };
}

function response(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    results: [],
    coverage_estimate: 0.8,
    result_confidence: 0.7,
    suggested_refinement: null,
    ...over,
  } as SearchResponse;
}

describe("formatSearch", () => {
  it("says so plainly when nothing matches", () => {
    const out = formatSearch(response(), "coffee");
    expect(out).toContain('No knowledge found for "coffee"');
  });

  it("includes the refinement hint on an empty result set", () => {
    const out = formatSearch(
      response({ suggested_refinement: "Try a broader term." }),
      "coffee",
    );
    expect(out).toContain("Try a broader term.");
  });

  it("renders the fact, its scope, score and confidence", () => {
    const out = formatSearch(
      response({ results: [result("Prefers dark roast coffee")] as any }),
      "coffee",
    );
    expect(out).toContain("Prefers dark roast coffee");
    expect(out).toContain("preferences/food");
    expect(out).toContain("score 0.123");
    expect(out).toContain("confidence 0.90");
  });

  it("omits the subdomain separator when there is no subdomain", () => {
    const out = formatSearch(
      response({ results: [result("The user is called Alex", "profile", null)] as any }),
      "alex",
    );
    expect(out).toContain("profile");
    expect(out).not.toContain("profile/");
  });

  it("pluralises the result count correctly", () => {
    expect(formatSearch(response({ results: [result("a")] as any }), "q")).toContain(
      "1 result for",
    );
    expect(
      formatSearch(response({ results: [result("a"), result("b")] as any }), "q"),
    ).toContain("2 results for");
  });

  it("surfaces retrieval quality so a thin result set looks thin", () => {
    const out = formatSearch(
      response({
        results: [result("Prefers dark roast coffee")] as any,
        coverage_estimate: 0.3,
        result_confidence: 0.25,
      }),
      "coffee",
    );
    expect(out).toContain("coverage 30%");
    expect(out).toContain("confidence 25%");
  });

  it("lists linked entities when a result has them", () => {
    const r = result("Robin likes sushi", "people", null);
    (r as any).entities = [{ name: "Robin" }];
    const out = formatSearch(response({ results: [r] as any }), "robin");
    expect(out).toContain("entities: Robin");
  });
});

describe("formatStats", () => {
  function stats(over: Partial<KnowledgeStats> = {}): KnowledgeStats {
    return {
      facts: { active_latest: 0, total: 0 },
      entities: 0,
      domains: 0,
      consolidations: 0,
      domain_distribution: [],
      embeddings: [],
      events: { count: 0, bytes: 0 },
      ...over,
    };
  }

  it("says nothing is captured on an empty store", () => {
    expect(formatStats(stats())).toContain("Nothing captured yet.");
  });

  it("reports the current fact count", () => {
    const out = formatStats(
      stats({ facts: { active_latest: 4, total: 4 }, domains: 3 }),
    );
    expect(out).toContain("4 current");
    expect(out).not.toContain("Nothing captured yet.");
  });

  it("shows the superseded gap only when history exists", () => {
    expect(formatStats(stats({ facts: { active_latest: 4, total: 4 } }))).not.toContain(
      "superseded",
    );
    const out = formatStats(stats({ facts: { active_latest: 4, total: 6 } }));
    expect(out).toContain("6 total (2 superseded)");
  });

  it("reports semantic coverage against the current fact count, not alone", () => {
    // A bare vector count says nothing: 40 embeddings is full coverage of 40
    // facts and a failed run over 100. The proportion is the whole signal.
    const out = formatStats(
      stats({
        facts: { active_latest: 100, total: 100 },
        embeddings: [{ model: "nomic-embed-text", dimensions: 768, count: 40 }],
      }),
    );
    expect(out).toContain("nomic-embed-text @ 768d  40/100 (40%)");
  });

  it("lists every model the store holds vectors for", () => {
    // Two pairs means a model or dimension changed. Search only reads one of
    // them, so a store that looks fully embedded may have almost no reachable
    // vectors — visible here and nowhere else.
    const out = formatStats(
      stats({
        facts: { active_latest: 10, total: 10 },
        embeddings: [
          { model: "voyage-3.5-lite", dimensions: 512, count: 10 },
          { model: "nomic-embed-text", dimensions: 768, count: 3 },
        ],
      }),
    );
    expect(out).toContain("voyage-3.5-lite @ 512d  10/10");
    expect(out).toContain("nomic-embed-text @ 768d  3/10");
  });

  it("says nothing about semantics when the store has no vectors", () => {
    // Keyword-only is the shipped default, not a fault. An empty section
    // reading "0%" would look like breakage on a store working as configured.
    expect(formatStats(stats({ facts: { active_latest: 4, total: 4 } }))).not.toContain(
      "Semantic coverage",
    );
  });

  it("renders the domain distribution aligned", () => {
    const out = formatStats(
      stats({
        facts: { active_latest: 3, total: 3 },
        domain_distribution: [
          { domain: "preferences", count: 2 },
          { domain: "work", count: 1 },
        ],
      }),
    );
    expect(out).toContain("By domain");
    // Shorter names pad to the longest so the counts line up.
    expect(out).toContain("preferences  2");
    expect(out).toContain("work         1");
  });

  it("omits the distribution section entirely when there is nothing to show", () => {
    expect(formatStats(stats())).not.toContain("By domain");
  });
});
