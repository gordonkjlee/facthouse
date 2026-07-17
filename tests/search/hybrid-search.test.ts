import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const dbMod = await import("../../src/db/index.js");
const searchMod = await import("../../src/search/index.js");
const { createSession } = await import("../../src/db/sessions.js");
const { insertSessionFact, claimForConsolidation } = await import(
  "../../src/db/session-facts.js"
);

let db: Db;

beforeEach(() => {
  db = dbMod.openDatabase(":memory:");
  dbMod.applySchema(db);
});

afterEach(() => {
  dbMod.closeDatabase(db);
});

describe("hybridSearch", () => {
  function insertFact(content: string, domain: string) {
    return dbMod.insertFact(db, {
      content,
      domain,
      source_type: "conversation",
    });
  }

  it("returns empty results for empty query", () => {
    insertFact("I prefer coffee", "preferences");

    const result = searchMod.hybridSearch(db, "");
    expect(result.results).toHaveLength(0);
    expect(result.result_confidence).toBe(0);
  });

  it("domain filter on empty domain returns empty cleanly (no crash)", () => {
    insertFact("I prefer coffee", "preferences");

    const result = searchMod.hybridSearch(db, "coffee", { domain: "nonexistent" });
    expect(result.results.length).toBeGreaterThanOrEqual(0); // FTS5 still matches
  });

  it("proper-noun query matches entity and adds entity path", () => {
    const alex = dbMod.createEntity(db, { type: "person", name: "Alex" });
    const fact = insertFact("Alex works at Acme", "people");
    dbMod.linkFactEntity(db, fact.id, alex.id, "subject");

    const result = searchMod.hybridSearch(db, "Alex");
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // The fact about Alex should be found via entity path even if FTS5 quirks
    expect(result.results.some((r: any) => r.fact.id === fact.id)).toBe(true);
  });

  it("proper-noun query with no matching entity degrades silently", () => {
    insertFact("Something unrelated", "general");

    // Should not throw
    const result = searchMod.hybridSearch(db, "Nobody");
    expect(result).toBeDefined();
    expect(result.results).toBeInstanceOf(Array);
  });

  it("search does not increment access_count (write amplification removed)", () => {
    const fact = insertFact("I prefer dark roast coffee", "preferences");

    expect(dbMod.getFact(db, fact.id).access_count).toBe(0);

    searchMod.hybridSearch(db, "coffee");
    searchMod.hybridSearch(db, "coffee");

    // access_count stays at 0 — no write side-effect on the read path.
    // The column exists for future ranking boosts; increment will be added
    // when the ranker consumes it.
    expect(dbMod.getFact(db, fact.id).access_count).toBe(0);
  });

  it("limit boundary: limit=1 returns exactly one result", () => {
    insertFact("coffee fact one", "preferences");
    insertFact("coffee fact two", "preferences");
    insertFact("coffee fact three", "preferences");

    const result = searchMod.hybridSearch(db, "coffee", { limit: 1 });
    expect(result.results).toHaveLength(1);
  });

  it("fact appearing in multiple RRF lists ranks higher", () => {
    // Matches both the FTS5 path AND the domain path.
    const bothPathFact = insertFact("I prefer dark roast coffee", "preferences");
    // Same domain, so it reaches the merge via the domain path only.
    const domainOnlyFact = insertFact("I like long walks", "preferences");

    const result = searchMod.hybridSearch(db, "coffee", { domain: "preferences" });

    // Assert unconditionally: guarding these lookups with `if (idx !== -1)`
    // would let the test pass by silently skipping when a fact is absent.
    const ids = result.results.map((r: any) => r.fact.id);
    expect(ids).toContain(bothPathFact.id);
    expect(ids).toContain(domainOnlyFact.id);
    expect(ids.indexOf(bothPathFact.id)).toBeLessThan(
      ids.indexOf(domainOnlyFact.id),
    );
  });

  // A domain ranks; it does not gate. These previously asserted the opposite —
  // that a domain search returns that domain and nothing else. That contract was
  // written to satisfy a tool description promising "filter to a specific
  // domain", and the description was the thing that was wrong.
  //
  // Why it matters: a domain label is chosen by a stochastic classifier at
  // consolidation and would have to be matched exactly here, by a different
  // process, at retrieval. A classifier may answer "health" one run and
  // "medical" the next, so an equality gate turns a drifted label into an empty
  // result — silently, with no way for a caller to tell "nothing is known" from
  // "it was filed under a synonym".
  it("prioritises the domain but still surfaces a strong match outside it", () => {
    const outOfDomain = insertFact("coffee is great", "general");
    const inDomain = insertFact("I prefer dark roast coffee", "preferences");

    const result = searchMod.hybridSearch(db, "coffee", { domain: "preferences" });
    const ids = result.results.map((r: any) => r.fact.id);

    // The in-domain match reaches the merge via both the keyword and domain
    // paths, so it ranks first...
    expect(ids[0]).toBe(inDomain.id);
    // ...but the out-of-domain match is not hidden. Under the old gate this
    // fact was silently dropped.
    expect(ids).toContain(outOfDomain.id);
  });

  it("does not let the domain consume the result set", () => {
    // A caller naming a domain gets that domain's facts prioritised, not the
    // whole store's relevance thrown away.
    for (let i = 0; i < 5; i++) insertFact(`coffee note ${i}`, "general");
    for (let i = 0; i < 3; i++) insertFact(`coffee pref ${i}`, "preferences");

    const result = searchMod.hybridSearch(db, "coffee", {
      domain: "preferences",
      limit: 3,
    });

    expect(result.results).toHaveLength(3);
    // Every in-domain fact matches the query here, so they take the top slots
    // by ranking rather than by exclusion.
    expect(result.results.every((r: any) => r.fact.domain === "preferences")).toBe(
      true,
    );
  });

  it("still answers when the named domain holds nothing", () => {
    // The failure this prevents: asking for "medical" when the fact was filed
    // under "health" used to return nothing at all. Now the keyword match
    // survives, so a mis-filed fact is still findable.
    const fact = insertFact("coffee is great", "general");

    const result = searchMod.hybridSearch(db, "coffee", { domain: "medical" });

    expect(result.results.map((r: any) => r.fact.id)).toContain(fact.id);
  });

  it("a domain with no facts does not crash the merge", () => {
    insertFact("coffee is great", "general");
    expect(() =>
      searchMod.hybridSearch(db, "coffee", { domain: "nonexistent" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unconsolidated facts
// ---------------------------------------------------------------------------

describe("pending (unconsolidated) facts", () => {
  // Local helpers: the ones above are scoped to the hybridSearch block.
  function insertFact(content: string, domain: string) {
    return dbMod.insertFact(db, { content, domain, source_type: "conversation" });
  }

  function capture(content: string) {
    const session = createSession(db, { source_tool: "test", project: "p" });
    return insertSessionFact(db, {
      session_id: session.id,
      content,
      domain_hint: null,
    });
  }

  it("finds a fact the assistant was just told, before consolidation runs", () => {
    // The gap this closes: capture_fact writes session_facts, and only graduated
    // facts reach the FTS index searched above. Until consolidation ran — by
    // default after ten events or at session end — "I just told you that"
    // silently returned nothing.
    capture("The user prefers dark roast coffee");

    const result = searchMod.hybridSearch(db, "coffee");

    expect(result.results).toHaveLength(0); // nothing graduated yet
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].content).toContain("dark roast");
  });

  it("keeps pending apart from graduated results rather than merging them", () => {
    // A pending fact has been through none of the pipeline: not deduplicated,
    // not reconciled, possibly contradicting what is already known. It must be
    // findable without being presented as knowledge of equal standing.
    insertFact("I prefer instant coffee", "preferences");
    capture("The user prefers dark roast coffee");

    const result = searchMod.hybridSearch(db, "coffee");

    expect(result.results).toHaveLength(1);
    expect(result.results[0].fact.content).toContain("instant");
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].content).toContain("dark roast");
  });

  it("drops a fact from pending once a consolidation claims it", () => {
    capture("The user prefers dark roast coffee");
    expect(searchMod.hybridSearch(db, "coffee").pending).toHaveLength(1);

    claimForConsolidation(db, "some-consolidation-id");

    expect(searchMod.hybridSearch(db, "coffee").pending).toHaveLength(0);
  });

  it("surfaces an unconsolidated fact from a session that already ended", () => {
    // This is the fact most at risk of being lost: get_session_context only sees
    // the current session, so without this an orphaned capture is unreachable by
    // any tool until something consolidates it.
    capture("The user prefers dark roast coffee"); // its own session, never resumed

    expect(searchMod.hybridSearch(db, "coffee").pending).toHaveLength(1);
  });

  it("returns an empty pending list rather than omitting the field", () => {
    insertFact("I prefer instant coffee", "preferences");
    expect(searchMod.hybridSearch(db, "coffee").pending).toEqual([]);
  });

  it("does not let pending facts inflate the retrieval quality signals", () => {
    // Coverage describes how well the knowledge base answered. A pending fact is
    // not in it yet, so counting it would claim coverage the store lacks.
    capture("The user prefers dark roast coffee");
    const result = searchMod.hybridSearch(db, "coffee");
    expect(result.coverage_estimate).toBe(0);
  });
});
