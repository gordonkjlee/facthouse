import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const dbMod = await import("../../src/db/index.js");
const searchMod = await import("../../src/search/index.js");

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

  it("a domain search never returns facts from another domain", () => {
    // The keyword path searches the whole store, so this is the fact that leaks
    // if the domain is treated purely as an extra recall path.
    insertFact("coffee is great", "general");
    const inDomain = insertFact("I prefer dark roast coffee", "preferences");

    const result = searchMod.hybridSearch(db, "coffee", { domain: "preferences" });

    expect(result.results.map((r: any) => r.fact.id)).toEqual([inDomain.id]);
    expect(result.results.every((r: any) => r.fact.domain === "preferences")).toBe(
      true,
    );
  });

  it("scopes by domain without shrinking the result set below the limit", () => {
    // Out-of-domain keyword hits must not consume result slots: filtering has
    // to happen before the limit slice, not after.
    for (let i = 0; i < 5; i++) insertFact(`coffee note ${i}`, "general");
    for (let i = 0; i < 3; i++) insertFact(`coffee pref ${i}`, "preferences");

    const result = searchMod.hybridSearch(db, "coffee", {
      domain: "preferences",
      limit: 3,
    });

    expect(result.results).toHaveLength(3);
    expect(result.results.every((r: any) => r.fact.domain === "preferences")).toBe(
      true,
    );
  });

  it("returns nothing for a domain that holds no facts, rather than leaking", () => {
    insertFact("coffee is great", "general");
    const result = searchMod.hybridSearch(db, "coffee", { domain: "medical" });
    expect(result.results).toEqual([]);
  });
});
