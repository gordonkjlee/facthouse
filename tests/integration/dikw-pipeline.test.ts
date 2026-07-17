/**
 * End-to-end integration test for the DIKW pipeline.
 * Proves: capture → consolidate → search → supersession.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";


const dbMod = await import("../../src/db/index.js");
const sessionMod = await import("../../src/tools/session-manager.js");
const factMod = await import("../../src/tools/fact-manager.js");
const heuristicMod = await import("../../src/intelligence/heuristic.js");
const searchMod = await import("../../src/search/index.js");

let db: Db;

beforeEach(() => {
  db = dbMod.openDatabase(":memory:");
  dbMod.applySchema(db);
});

afterEach(() => {
  dbMod.closeDatabase(db);
});


/**
 * A provider that reports an entity for every fact.
 *
 * These tests used to rely on the fallback's `my partner Robin` regex. That rule
 * is gone — a personal ontology hardcoded in a general engine — so the fallback
 * extracts nothing. These tests are about what the *pipeline* does with entities
 * (create, link, feed the entity search path), not about whether a regex finds
 * one, so they supply their own.
 */
function withEntity(name: string, relationship = "mentioned_in") {
  const base = heuristicMod.createHeuristicProvider(PERSONAL_VOCABULARY);
  return {
    ...base,
    async extractEntities(facts: Array<{ id: string }>) {
      const map = new Map<string, Array<Record<string, string>>>();
      for (const f of facts) map.set(f.id, [{ name, type: "person", relationship }]);
      return map;
    },
  } as never;
}

describe("DIKW pipeline end-to-end", () => {
  function setup(intelligenceOverride?: unknown) {
    const intelligence =
      (intelligenceOverride as never) ??
      heuristicMod.createHeuristicProvider(PERSONAL_VOCABULARY);
    const sessionManager = sessionMod.createSessionManager(db);
    sessionManager.startSession("test-client", "test-project");
    const factManager = factMod.createFactManager(db, sessionManager, {
      autoLinkEvents: 5,
      intelligence,
      // The vocabulary is data now: the engine ships no domains, so a test that
      // expects routing or calibration has to configure one, exactly as a user
      // does.
      serverConfig: { domains: PERSONAL_VOCABULARY },
    });
    return { sessionManager, factManager, intelligence };
  }

  it("captures facts, consolidates, and retrieves structured knowledge", async () => {
    const { factManager } = setup();

    // D → Staging: capture facts
    factManager.captureFact({ content: "My name is Alex", domain_hint: "profile", importance: 0.9 });
    factManager.captureFact({ content: "I prefer dark roast coffee", domain_hint: "preferences" });
    factManager.captureFact({ content: "I'm allergic to aspirin", domain_hint: "medical" });
    factManager.captureFact({ content: "I prefer dark roast coffee" }); // duplicate — should be rejected

    // Verify: 3 unique session_facts (1 duplicate rejected)
    const context = factManager.getSessionContext();
    expect(context).toHaveLength(3);

    // Verify: 0 graduated facts yet
    const preFacts = searchMod.structuredSearch(db, {});
    expect(preFacts).toHaveLength(0);

    // Staging → Knowledge: consolidate
    const result = await factManager.runConsolidate();

    expect(result.skipped).toBe(false);
    expect(result.factsIn).toBe(3);
    expect(result.factsGraduated).toBe(3);
    expect(result.summary).toBeTruthy();

    // Verify: graduated facts exist with correct domains
    const profileFacts = searchMod.structuredSearch(db, { domain: "profile" });
    expect(profileFacts).toHaveLength(1);
    expect(profileFacts[0].content).toContain("Alex");

    const prefFacts = searchMod.structuredSearch(db, { domain: "preferences" });
    expect(prefFacts).toHaveLength(1);

    const medFacts = searchMod.structuredSearch(db, { domain: "medical" });
    expect(medFacts).toHaveLength(1);
  });

  it("hybrid search finds graduated facts", async () => {
    const { factManager } = setup();

    factManager.captureFact({ content: "I prefer dark roast coffee", domain_hint: "preferences" });
    await factManager.runConsolidate();

    const searchResult = searchMod.hybridSearch(db, "coffee");
    expect(searchResult.results).toHaveLength(1);
    expect(searchResult.results[0].fact.content).toContain("coffee");
    expect(searchResult.coverage_estimate).toBeGreaterThan(0);
    expect(searchResult.result_confidence).toBeGreaterThan(0);
  });

  it("supersedes contradictory facts across consolidations", async () => {
    const { sessionManager, intelligence } = setup();
    const { getFact } = await import("../../src/db/facts.js");

    // First session: capture coffee
    const fm1 = factMod.createFactManager(db, sessionManager, { autoLinkEvents: 0, intelligence });
    fm1.captureFact({ content: "I prefer dark roast coffee", domain_hint: "preferences" });
    await fm1.runConsolidate();

    const beforeFacts = searchMod.structuredSearch(db, { domain: "preferences" });
    expect(beforeFacts).toHaveLength(1);
    const coffeeId = beforeFacts[0].id;
    expect(beforeFacts[0].content).toContain("coffee");
    expect(beforeFacts[0].is_latest).toBe(true);
    expect(beforeFacts[0].status).toBe("active");

    // Second session: capture contradictory fact with negation marker
    sessionManager.startSession("test-client-2", null);
    const fm2 = factMod.createFactManager(db, sessionManager, { autoLinkEvents: 0, intelligence });
    fm2.captureFact({
      content: "I now prefer green tea instead of coffee",
      domain_hint: "preferences",
    });
    await fm2.runConsolidate();

    // Only tea should be in the latest/active set — exactly one fact
    const afterFacts = searchMod.structuredSearch(db, { domain: "preferences" });
    expect(afterFacts).toHaveLength(1);
    expect(afterFacts[0].content).toContain("tea");
    const teaId = afterFacts[0].id;
    expect(teaId).not.toBe(coffeeId);

    // Old coffee fact must be superseded: is_latest=0, status='superseded',
    // valid_until set, superseded_by pointing at tea
    const oldCoffee = getFact(db, coffeeId);
    expect(oldCoffee).not.toBeNull();
    expect(oldCoffee!.is_latest).toBe(false);
    expect(oldCoffee!.status).toBe("superseded");
    expect(oldCoffee!.valid_until).not.toBeNull();
    expect(oldCoffee!.superseded_by).toBe(teaId);

    // Facts are immutable — coffee still exists in the table (historical lookup)
    expect(oldCoffee!.content).toContain("coffee");
  });

  it("detail-addition facts coexist with their more-general parents (no silent dedup)", async () => {
    const { sessionManager, intelligence } = setup();

    // First session: capture the general preference
    const fm1 = factMod.createFactManager(db, sessionManager, { autoLinkEvents: 0, intelligence });
    fm1.captureFact({
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });
    await fm1.runConsolidate();

    // Second session: add a more specific detail, not a contradiction
    sessionManager.startSession("test-client-2", null);
    const fm2 = factMod.createFactManager(db, sessionManager, { autoLinkEvents: 0, intelligence });
    fm2.captureFact({
      content: "I prefer dark roast coffee from Colombia",
      domain_hint: "preferences",
    });
    await fm2.runConsolidate();

    // Both facts should survive — neither is a supersession of the other,
    // and cross-session exact-dedup must not silently collapse them.
    const prefs = searchMod.structuredSearch(db, { domain: "preferences" });
    expect(prefs).toHaveLength(2);
    const contents = prefs.map((f: any) => f.content).sort();
    expect(contents).toEqual([
      "I prefer dark roast coffee",
      "I prefer dark roast coffee from Colombia",
    ]);
    // Neither should be marked superseded
    for (const f of prefs) {
      expect(f.status).toBe("active");
      expect(f.is_latest).toBe(true);
    }
  });

  it("entity path contributes to search after consolidation", async () => {
    const { factManager } = setup(withEntity("Robin"));

    factManager.captureFact({ content: "my partner Robin loves sushi" });
    factManager.captureFact({ content: "my friend Robin works at Acme" });
    await factManager.runConsolidate();

    // Entity "Robin" should exist
    const { findEntity } = await import("../../src/db/entities.js");
    const robin = findEntity(db, "Robin", "person");
    expect(robin).not.toBeNull();

    // Search for Robin — entity path should contribute facts via hybridSearch
    const result = searchMod.hybridSearch(db, "Robin");
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r: any) => r.fact.content.includes("Robin"))).toBe(true);
  });

  it("get_session_context returns in-session working memory before consolidation", () => {
    const { factManager } = setup();

    factManager.captureFact({ content: "fact A" });
    factManager.captureFact({ content: "fact B" });
    factManager.captureFact({ content: "fact C" });

    // In-session recall works immediately (working memory, pre-consolidation)
    const context = factManager.getSessionContext();
    expect(context).toHaveLength(3);
    expect(context.map((f: any) => f.content)).toEqual(["fact A", "fact B", "fact C"]);

    // But search doesn't find them yet (not consolidated)
    const searchResult = searchMod.hybridSearch(db, "fact A");
    expect(searchResult.results).toHaveLength(0);
  });

  it("consolidation is idempotent", async () => {
    const { factManager } = setup();

    factManager.captureFact({ content: "Some important fact", domain_hint: "general" });

    const first = await factManager.runConsolidate();
    expect(first.factsIn).toBe(1);
    expect(first.factsGraduated).toBe(1);

    const second = await factManager.runConsolidate();
    expect(second.factsIn).toBe(0);
    expect(second.factsGraduated).toBe(0);
  });

  it("consolidation creates entities and links them to facts", async () => {
    const { factManager } = setup(withEntity("Robin", "partner_of"));

    factManager.captureFact({
      content: "Had dinner with my partner Robin",
      domain_hint: "people",
    });
    await factManager.runConsolidate();

    // Check entity was created
    const robin = dbMod.findEntity(db, "Robin");
    expect(robin).not.toBeNull();
    expect(robin!.type).toBe("person");
    expect(robin!.canonical_name).toBe("robin");
  });

  it("importance defaults are respected through the pipeline", async () => {
    const { factManager } = setup();

    // The configured vocabulary declares medical at 0.9
    factManager.captureFact({
      content: "I'm allergic to aspirin",
      domain_hint: "medical",
    });
    await factManager.runConsolidate();

    const medFacts = searchMod.structuredSearch(db, { domain: "medical" });
    expect(medFacts).toHaveLength(1);
    expect(medFacts[0].importance).toBe(0.9); // as declared by the configured vocabulary
  });

  it("consolidation record is created with stats", async () => {
    const { factManager } = setup();

    factManager.captureFact({ content: "fact one", domain_hint: "general" });
    factManager.captureFact({ content: "fact two", domain_hint: "general" });

    const result = await factManager.runConsolidate();

    // Verify consolidation record
    const record = db
      .prepare("SELECT * FROM consolidations WHERE id = ?")
      .get(result.consolidationId) as any;

    expect(record).toBeTruthy();
    expect(record.facts_in).toBe(2);
    expect(record.facts_graduated).toBe(2);
    expect(record.summary).toBeTruthy();
  });

  it("domains are created during consolidation", async () => {
    const { factManager } = setup();

    factManager.captureFact({ content: "I'm allergic to aspirin", domain_hint: "medical" });
    await factManager.runConsolidate();

    const domains = dbMod.getDomains(db);
    const domainNames = domains.map((d: any) => d.name);
    expect(domainNames).toContain("medical");
  });

  it("search returns retrieval quality signals", async () => {
    const { factManager } = setup();

    factManager.captureFact({ content: "I prefer dark roast coffee", domain_hint: "preferences" });
    factManager.captureFact({ content: "I enjoy hiking on weekends", domain_hint: "preferences" });
    await factManager.runConsolidate();

    const result = searchMod.hybridSearch(db, "coffee");
    expect(result).toHaveProperty("coverage_estimate");
    expect(result).toHaveProperty("result_confidence");
    expect(result).toHaveProperty("suggested_refinement");
    expect(typeof result.coverage_estimate).toBe("number");
    expect(typeof result.result_confidence).toBe("number");
  });
});
