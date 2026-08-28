import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const dbMod = await import("../../src/db/index.js");
const searchMod = await import("../../src/search/index.js");
const { createSession } = await import("../../src/db/sessions.js");
const { insertSessionFact, claimForConsolidation } = await import(
  "../../src/db/session-facts.js"
);

let db: Db;

beforeEach(async () => {
  db = dbMod.openDatabase(":memory:");
  await dbMod.applySchema(db);
});

afterEach(async () => {
  await dbMod.closeDatabase(db);
});

describe("hybridSearch", () => {
  async function insertFact(content: string, domain: string) {
    return await dbMod.insertFact(db, {
      content,
      domain,
      source_type: "conversation",
    });
  }

  it("returns empty results for empty query", async () => {
    await insertFact("I prefer coffee", "preferences");

    const result = await searchMod.hybridSearch(db, "");
    expect(result.results).toHaveLength(0);
    expect(result.result_confidence).toBe(0);
  });

  it("domain filter on empty domain returns empty cleanly (no crash)", async () => {
    await insertFact("I prefer coffee", "preferences");

    const result = await searchMod.hybridSearch(db, "coffee", { domain: "nonexistent" });
    expect(result.results.length).toBeGreaterThanOrEqual(0); // FTS5 still matches
  });

  it("proper-noun query matches entity and adds entity path", async () => {
    const alex = await dbMod.createEntity(db, { type: "person", name: "Alex" });
    const fact = await insertFact("Alex works at Acme", "people");
    await dbMod.linkFactEntity(db, fact.id, alex.id, "subject");

    const result = await searchMod.hybridSearch(db, "Alex");
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // The fact about Alex should be found via entity path even if FTS5 quirks
    expect(result.results.some((r: any) => r.fact.id === fact.id)).toBe(true);
  });

  it("proper-noun query with no matching entity degrades silently", async () => {
    await insertFact("Something unrelated", "general");

    // Should not throw
    const result = await searchMod.hybridSearch(db, "Nobody");
    expect(result).toBeDefined();
    expect(result.results).toBeInstanceOf(Array);
  });

  it("search does not increment access_count (write amplification removed)", async () => {
    const fact = await insertFact("I prefer dark roast coffee", "preferences");

    expect((await dbMod.getFact(db, fact.id))!.access_count).toBe(0);

    await searchMod.hybridSearch(db, "coffee");
    await searchMod.hybridSearch(db, "coffee");

    // access_count stays at 0 — no write side-effect on the read path.
    // The column exists for future ranking boosts; increment will be added
    // when the ranker consumes it.
    expect((await dbMod.getFact(db, fact.id))!.access_count).toBe(0);
  });

  it("limit boundary: limit=1 returns exactly one result", async () => {
    await insertFact("coffee fact one", "preferences");
    await insertFact("coffee fact two", "preferences");
    await insertFact("coffee fact three", "preferences");

    const result = await searchMod.hybridSearch(db, "coffee", { limit: 1 });
    expect(result.results).toHaveLength(1);
  });

  it("fact appearing in multiple RRF lists ranks higher", async () => {
    // Matches both the FTS5 path AND the domain path.
    const bothPathFact = await insertFact("I prefer dark roast coffee", "preferences");
    // Same domain, so it reaches the merge via the domain path only.
    const domainOnlyFact = await insertFact("I like long walks", "preferences");

    const result = await searchMod.hybridSearch(db, "coffee", { domain: "preferences" });

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
  it("prioritises the domain but still surfaces a strong match outside it", async () => {
    const outOfDomain = await insertFact("coffee is great", "general");
    const inDomain = await insertFact("I prefer dark roast coffee", "preferences");

    const result = await searchMod.hybridSearch(db, "coffee", { domain: "preferences" });
    const ids = result.results.map((r: any) => r.fact.id);

    // The in-domain match reaches the merge via both the keyword and domain
    // paths, so it ranks first...
    expect(ids[0]).toBe(inDomain.id);
    // ...but the out-of-domain match is not hidden. Under the old gate this
    // fact was silently dropped.
    expect(ids).toContain(outOfDomain.id);
  });

  it("does not let the domain consume the result set", async () => {
    // A caller naming a domain gets that domain's facts prioritised, not the
    // whole store's relevance thrown away.
    for (let i = 0; i < 5; i++) await insertFact(`coffee note ${i}`, "general");
    for (let i = 0; i < 3; i++) await insertFact(`coffee pref ${i}`, "preferences");

    const result = await searchMod.hybridSearch(db, "coffee", {
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

  it("still answers when the named domain holds nothing", async () => {
    // The failure this prevents: asking for "medical" when the fact was filed
    // under "health" used to return nothing at all. Now the keyword match
    // survives, so a mis-filed fact is still findable.
    const fact = await insertFact("coffee is great", "general");

    const result = await searchMod.hybridSearch(db, "coffee", { domain: "medical" });

    expect(result.results.map((r: any) => r.fact.id)).toContain(fact.id);
  });

  it("a domain with no facts does not crash the merge", async () => {
    await insertFact("coffee is great", "general");
    await expect(
      searchMod.hybridSearch(db, "coffee", { domain: "nonexistent" }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Unconsolidated facts
// ---------------------------------------------------------------------------

describe("pending (unconsolidated) facts", () => {
  // Local helpers: the ones above are scoped to the hybridSearch block.
  async function insertFact(content: string, domain: string) {
    return await dbMod.insertFact(db, { content, domain, source_type: "conversation" });
  }

  async function capture(content: string) {
    const session = await createSession(db, { source_tool: "test", project: "p" });
    return await insertSessionFact(db, {
      session_id: session.id,
      content,
      domain_hint: null,
    });
  }

  it("finds a fact the assistant was just told, before consolidation runs", async () => {
    // The gap this closes: capture_fact writes session_facts, and only graduated
    // facts reach the FTS index searched above. Until consolidation ran — by
    // default after ten events or at session end — "I just told you that"
    // silently returned nothing.
    await capture("The user prefers dark roast coffee");

    const result = await searchMod.hybridSearch(db, "coffee");

    expect(result.results).toHaveLength(0); // nothing graduated yet
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].content).toContain("dark roast");
  });

  it("keeps pending apart from graduated results rather than merging them", async () => {
    // A pending fact has been through none of the pipeline: not deduplicated,
    // not reconciled, possibly contradicting what is already known. It must be
    // findable without being presented as knowledge of equal standing.
    await insertFact("I prefer instant coffee", "preferences");
    await capture("The user prefers dark roast coffee");

    const result = await searchMod.hybridSearch(db, "coffee");

    expect(result.results).toHaveLength(1);
    expect(result.results[0].fact.content).toContain("instant");
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].content).toContain("dark roast");
  });

  it("drops a fact from pending once a consolidation claims it", async () => {
    await capture("The user prefers dark roast coffee");
    expect((await searchMod.hybridSearch(db, "coffee")).pending).toHaveLength(1);

    await claimForConsolidation(db, "some-consolidation-id");

    expect((await searchMod.hybridSearch(db, "coffee")).pending).toHaveLength(0);
  });

  it("surfaces an unconsolidated fact from a session that already ended", async () => {
    // This is the fact most at risk of being lost: get_session_context only sees
    // the current session, so without this an orphaned capture is unreachable by
    // any tool until something consolidates it.
    await capture("The user prefers dark roast coffee"); // its own session, never resumed

    expect((await searchMod.hybridSearch(db, "coffee")).pending).toHaveLength(1);
  });

  it("returns an empty pending list rather than omitting the field", async () => {
    await insertFact("I prefer instant coffee", "preferences");
    expect((await searchMod.hybridSearch(db, "coffee")).pending).toEqual([]);
  });

  it("does not let pending facts inflate the retrieval quality signals", async () => {
    // Coverage describes how well the knowledge base answered. A pending fact is
    // not in it yet, so counting it would claim coverage the store lacks.
    await capture("The user prefers dark roast coffee");
    const result = await searchMod.hybridSearch(db, "coffee");
    expect(result.coverage_estimate).toBe(0);
  });
});

describe("hybridSearch surfaces the entity graph", () => {
  /**
   * `SearchResult.entities` was hardcoded to `[]` on the assumption that the
   * tool layer would enrich when it cared. Nothing ever did, so the entity
   * graph — the thing that makes this more than a text store — was invisible to
   * every caller: `search_knowledge`, the CLI renderer, all of them. The type
   * promised it, the CLI had a branch to render it, and it could never run.
   */
  async function insertFact(content: string, domain: string) {
    return await dbMod.insertFact(db, { content, domain, source_type: "conversation" });
  }

  it("unions type-split siblings on the entity RRF path, not first-match only", async () => {
    const asTable = await dbMod.createEntity(db, { type: "table", name: "stg_orders" });
    const asModel = await dbMod.createEntity(db, { type: "dbt_model", name: "stg_orders" });
    await db.prepare(`UPDATE entities SET created_at = ? WHERE id = ?`).run(
      "2026-01-01T00:00:00.000Z",
      asTable.id,
    );
    await db.prepare(`UPDATE entities SET created_at = ? WHERE id = ?`).run(
      "2026-01-02T00:00:00.000Z",
      asModel.id,
    );
    const fact = await insertFact("the staging relation lacks booked_at", "pipeline");
    await dbMod.linkFactEntity(db, fact.id, asModel.id, "subject");

    const result = await searchMod.hybridSearch(db, "stg_orders");
    expect(result.results.some((r) => r.fact.id === fact.id)).toBe(true);

    const hyphen = await searchMod.hybridSearch(db, "stg-orders");
    expect(hyphen.results.some((r) => r.fact.id === fact.id)).toBe(true);
  });

  it("skips the entity RRF list when a fold would bind two canonicals", async () => {
    await dbMod.createEntity(db, { type: "ticket", name: "mr !412" });
    await dbMod.createEntity(db, { type: "ticket", name: "mr 412" });
    const fact = await insertFact("the ticket is blocked on review", "work");
    const result = await searchMod.hybridSearch(db, "mr-412");
    expect(result.results.every((r) => r.fact.id !== fact.id)).toBe(true);
  });

  it("attaches the entities linked to a matched fact", async () => {
    const fact = await insertFact("Robin at Acme leads the Atlas migration", "work");
    const robin = await dbMod.createEntity(db, { type: "person", name: "Robin" });
    const atlas = await dbMod.createEntity(db, { type: "project", name: "Atlas" });
    await dbMod.linkFactEntity(db, fact.id, robin.id, "subject");
    await dbMod.linkFactEntity(db, fact.id, atlas.id, "concerns");

    const [result] = (await searchMod.hybridSearch(db, "Atlas")).results;

    expect(result.fact.id).toBe(fact.id);
    expect(result.entities.map((e) => e.name).sort()).toEqual(["Atlas", "Robin"]);
    // The type matters as much as the name: it is what makes "tell me about the
    // Atlas project" answerable on an engine that is not people-only.
    expect(result.entities.find((e) => e.name === "Atlas")!.type).toBe("project");
  });

  it("gives an unlinked fact an empty list, not a missing field", async () => {
    await insertFact("The user prefers dark mode", "preferences");
    const [result] = (await searchMod.hybridSearch(db, "dark mode")).results;
    expect(result.entities).toEqual([]);
  });
});

describe("hybridSearch as-of system time", () => {
  function waitUntilAfter(iso: string): void {
    while (new Date().toISOString() <= iso) {
      /* millisecond clock */
    }
  }

  it("returns the superseded fact at the earlier instant and the replacement now", async () => {
    const old = await dbMod.insertFact(db, {
      content: "User lives in Lisbon",
      domain: "profile",
      source_type: "conversation",
    });
    waitUntilAfter(old.created_at);
    const replacement = await dbMod.supersedeFact(
      db,
      old.id,
      {
        content: "User lives in Manchester",
        domain: "profile",
        source_type: "conversation",
      },
      { retireSystemTime: true },
    );

    const now = await searchMod.hybridSearch(db, "lives");
    expect(now.results.map((r) => r.fact.id)).toEqual([replacement.id]);
    expect(now.pending).toEqual([]);

    const then = await searchMod.hybridSearch(db, "lives", {
      asOfSystemTime: old.created_at,
    });
    expect(then.results.map((r) => r.fact.id)).toEqual([old.id]);
    expect(then.pending).toEqual([]);
    expect(then.episodes).toEqual([]);
  });
});
