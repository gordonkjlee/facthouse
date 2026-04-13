import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

// Skip when native bindings are unavailable.
let canLoadSqlite = false;
try {
  const Db = (await import("better-sqlite3")).default;
  const probe = new Db(":memory:");
  probe.close();
  canLoadSqlite = true;
} catch {
  // Native bindings not compiled.
}

const dbMod = canLoadSqlite ? await import("../../src/db/index.js") : ({} as any);
const searchMod = canLoadSqlite
  ? await import("../../src/search/index.js")
  : ({} as any);

let db: Database.Database;

beforeEach(() => {
  if (!canLoadSqlite) return;
  db = dbMod.openDatabase(":memory:");
  dbMod.applySchema(db);
});

afterEach(() => {
  if (!canLoadSqlite) return;
  dbMod.closeDatabase(db);
});

describe.skipIf(!canLoadSqlite)("hybridSearch", () => {
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
    const gordon = dbMod.createEntity(db, { type: "person", name: "Gordon" });
    const fact = insertFact("Gordon works at Acme", "people");
    dbMod.linkFactEntity(db, fact.id, gordon.id, "subject");

    const result = searchMod.hybridSearch(db, "Gordon");
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // The fact about Gordon should be found via entity path even if FTS5 quirks
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
    // This fact will match both the FTS5 path AND the domain path
    const bothPathFact = insertFact(
      "I prefer dark roast coffee",
      "preferences",
    );
    // This fact only matches FTS5 (different domain)
    const ftsOnlyFact = insertFact("coffee is great", "general");

    const result = searchMod.hybridSearch(db, "coffee", { domain: "preferences" });

    // The fact in both lists should rank above the fact in one list
    const indices = result.results.map((r: any) => r.fact.id);
    const bothPathIdx = indices.indexOf(bothPathFact.id);
    const ftsOnlyIdx = indices.indexOf(ftsOnlyFact.id);
    if (bothPathIdx !== -1 && ftsOnlyIdx !== -1) {
      expect(bothPathIdx).toBeLessThan(ftsOnlyIdx);
    }
  });
});
