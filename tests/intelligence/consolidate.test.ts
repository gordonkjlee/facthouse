import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

// ---------------------------------------------------------------------------
// Guard: skip when native bindings are unavailable
// ---------------------------------------------------------------------------


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { insertFact, getFactsByDomain } = await import("../../src/db/facts.js");
const { findEntity } = await import("../../src/db/entities.js");
const { ensureDomain } = await import("../../src/db/domains.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => {
  closeDatabase(db);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupSession(): string {
  const session = createSession(db, {
    source_tool: "test-client",
    project: "openmemory",
  });
  return session.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consolidation pipeline", () => {
  it("consolidates session_facts into graduated facts", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
      domain_hint: "profile",
    });
    insertSessionFact(db, {
      session_id: sessionId,
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });
    insertSessionFact(db, {
      session_id: sessionId,
      content: "I'm allergic to aspirin",
      domain_hint: "medical",
    });

    const result = await consolidate(db, provider);

    expect(result.skipped).toBe(false);
    expect(result.factsIn).toBe(3);
    expect(result.factsGraduated).toBe(3);
    expect(result.factsRejected).toBe(0);

    // Verify graduated facts exist in their correct domains
    const profileFacts = getFactsByDomain(db, "profile");
    expect(profileFacts.length).toBeGreaterThanOrEqual(1);
    expect(profileFacts.some((f: any) => f.content.includes("Alex"))).toBe(true);

    const prefFacts = getFactsByDomain(db, "preferences");
    expect(prefFacts.length).toBeGreaterThanOrEqual(1);

    const medFacts = getFactsByDomain(db, "medical");
    expect(medFacts.length).toBeGreaterThanOrEqual(1);
  });

  it("creates entities from facts mentioning people", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    // Entity regex expects lowercase "my" at word boundary
    insertSessionFact(db, {
      session_id: sessionId,
      content: "my partner Robin loves sushi",
    });

    const result = await consolidate(db, provider);

    expect(result.skipped).toBe(false);
    expect(result.entitiesCreated).toBeGreaterThanOrEqual(1);

    const entity = findEntity(db, "Robin", "person");
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe("Robin");
  });

  it("links entities to graduated facts", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    insertSessionFact(db, {
      session_id: sessionId,
      content: "my partner Robin loves sushi",
    });

    const result = await consolidate(db, provider);

    expect(result.entitiesLinked).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates exact content matches (reconcile returns noop)", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    // Pre-insert a graduated fact
    ensureDomain(db, "profile");
    insertFact(db, {
      content: "My name is Alex",
      domain: "profile",
      source_type: "conversation",
    });

    // Insert the same content as a session fact
    insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    const result = await consolidate(db, provider);

    expect(result.factsIn).toBe(1);
    expect(result.factsRejected).toBe(1);
    expect(result.factsGraduated).toBe(0);
  });

  it("skips when lock is held by another process", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    insertSessionFact(db, {
      session_id: sessionId,
      content: "Some fact",
    });

    // Manually insert a lock row with a recent timestamp
    db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at) VALUES (1, ?, ?)`,
    ).run("other-process", new Date().toISOString());

    const result = await consolidate(db, provider);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("Another consolidation");
  });

  it("is idempotent: second consolidation on same data returns 0 facts_in", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    const first = await consolidate(db, provider);
    expect(first.factsIn).toBe(1);
    expect(first.factsGraduated).toBe(1);

    // Second run: no unclaimed session_facts remain
    const second = await consolidate(db, provider);
    expect(second.factsIn).toBe(0);
    expect(second.factsGraduated).toBe(0);
  });

  it("generates a summary", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
      domain_hint: "profile",
    });
    insertSessionFact(db, {
      session_id: sessionId,
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, provider);

    expect(result.summary).not.toBeNull();
    expect(result.summary).toContain("2 facts");
  });

  it("creates consolidation record in consolidations table", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    const result = await consolidate(db, provider);

    const record = db
      .prepare(`SELECT * FROM consolidations WHERE id = ?`)
      .get(result.consolidationId) as any;

    expect(record).toBeDefined();
    expect(record.facts_in).toBe(1);
    expect(record.facts_graduated).toBe(1);
    expect(record.session_id).toBe(sessionId);
  });

  it("releases lock after completion", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    await consolidate(db, provider);

    const lockRow = db
      .prepare(`SELECT * FROM consolidation_lock WHERE id = 1`)
      .get();

    expect(lockRow).toBeUndefined();
  });

  it("sets consolidation_id on claimed session_facts", async () => {
    const sessionId = setupSession();
    const provider = createHeuristicProvider();

    insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    const result = await consolidate(db, provider);

    const facts = db
      .prepare(`SELECT * FROM session_facts WHERE session_id = ?`)
      .all(sessionId) as any[];

    expect(facts).toHaveLength(1);
    expect(facts[0].consolidation_id).toBe(result.consolidationId);
  });

  it("unclaims session_facts when the pipeline throws mid-run", async () => {
    const session = createSession(db, { source_tool: "test", project: null });
    insertSessionFact(db, { session_id: session.id, content: "will be unclaimed" });

    // Provider that always throws during classification
    const failingProvider = {
      ...createHeuristicProvider(),
      classifyFacts: async () => {
        throw new Error("simulated provider failure");
      },
    };

    await expect(consolidate(db, failingProvider)).rejects.toThrow("simulated provider failure");

    // Facts should be unclaimed (consolidation_id = NULL), not orphaned
    const facts = db
      .prepare(`SELECT * FROM session_facts WHERE session_id = ?`)
      .all(session.id) as any[];
    expect(facts).toHaveLength(1);
    expect(facts[0].consolidation_id).toBeNull();

    // Lock must have been released — otherwise next consolidation would skip
    const { getLockState } = await import("../../src/db/consolidation-lock.js");
    expect(getLockState(db)).toBeNull();

    // Next consolidation should pick them up
    const retry = await consolidate(db, createHeuristicProvider());
    expect(retry.factsIn).toBe(1);
  });

  it("handles two new facts targeting the same existing fact for supersession", async () => {
    const session = createSession(db, { source_tool: "test", project: null });

    // Pre-existing fact that two new ones will try to supersede
    insertFact(db, {
      content: "I prefer dark roast coffee every morning",
      domain: "preferences",
      source_type: "conversation",
    });

    // Two new session facts both contradicting the existing one
    insertSessionFact(db, {
      session_id: session.id,
      content: "I no longer prefer dark roast coffee every morning",
      domain_hint: "preferences",
    });
    insertSessionFact(db, {
      session_id: session.id,
      content: "I stopped drinking dark roast coffee every morning",
      domain_hint: "preferences",
    });

    // Should not throw — dedup prevents transaction rollback
    const result = await consolidate(db, createHeuristicProvider());

    expect(result.skipped).toBe(false);
    expect(result.factsGraduated).toBe(2);
    // Exactly one supersession (the first candidate wins)
    expect(result.supersessions).toBe(1);
  });

  it("consolidation record session_id is null when batch spans multiple sessions", async () => {
    const s1 = createSession(db, { source_tool: "test", project: null });
    const s2 = createSession(db, { source_tool: "test", project: null });

    insertSessionFact(db, { session_id: s1.id, content: "fact from session 1", domain_hint: "profile" });
    insertSessionFact(db, { session_id: s2.id, content: "fact from session 2", domain_hint: "profile" });

    const result = await consolidate(db, createHeuristicProvider());
    expect(result.factsIn).toBe(2);

    const record = db
      .prepare("SELECT session_id FROM consolidations WHERE id = ?")
      .get(result.consolidationId) as { session_id: string | null };

    expect(record.session_id).toBeNull();
  });

  it("deduplicates identical content across sessions within one batch (D3)", async () => {
    const s1 = createSession(db, { source_tool: "test", project: null });
    const s2 = createSession(db, { source_tool: "test", project: null });

    // Same content in two sessions — per-session hash dedup doesn't catch this
    insertSessionFact(db, {
      session_id: s1.id,
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });
    insertSessionFact(db, {
      session_id: s2.id,
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, createHeuristicProvider());
    expect(result.factsIn).toBe(2);
    // Only one graduates — the second is rejected as intra-batch duplicate
    expect(result.factsGraduated).toBe(1);
    expect(result.factsRejected).toBe(1);

    // Verify: exactly one active fact in the preferences domain
    const facts = getFactsByDomain(db, "preferences");
    expect(facts).toHaveLength(1);
  });

  it("reconciles cross-domain duplicates via domain scan (not FTS5)", async () => {
    const session = createSession(db, { source_tool: "test", project: null });

    // Pre-existing fact — long enough that FTS5 AND-semantics would miss paraphrases
    insertFact(db, {
      content: "I prefer dark roast Ethiopian coffee from Blue Bottle in the morning",
      domain: "preferences",
      source_type: "conversation",
    });

    // New fact with identical content should be deduplicated by heuristic reconcile
    insertSessionFact(db, {
      session_id: session.id,
      content: "I prefer dark roast Ethiopian coffee from Blue Bottle in the morning",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, createHeuristicProvider());
    // Heuristic reconcile returns "noop" on exact content match
    expect(result.factsRejected).toBe(1);
    expect(result.factsGraduated).toBe(0);
  });

  it("graduated facts have a source_id linking back to provenance (C1)", async () => {
    const session = createSession(db, { source_tool: "test", project: null });
    insertSessionFact(db, {
      session_id: session.id,
      content: "I prefer dark roast",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, createHeuristicProvider());
    expect(result.factsGraduated).toBe(1);

    // Graduated fact should have source_id set
    const graduatedFact = db
      .prepare(`SELECT * FROM facts WHERE source_id IS NOT NULL LIMIT 1`)
      .get() as any;
    expect(graduatedFact).toBeTruthy();
    expect(graduatedFact.source_id).toBeTruthy();

    // Source should exist and contain session_fact_id in metadata
    const source = db
      .prepare(`SELECT * FROM sources WHERE id = ?`)
      .get(graduatedFact.source_id) as any;
    expect(source).toBeTruthy();
    expect(source.type).toBe("session-fact");
    const metadata = JSON.parse(source.metadata);
    expect(metadata.session_fact_id).toBeTruthy();
    expect(metadata.session_id).toBe(session.id);
  });

  it("low-confidence negation DOES supersede high-confidence prior (intentional)", async () => {
    const session = createSession(db, { source_tool: "test", project: null });

    // High-confidence existing fact
    const oldFact = insertFact(db, {
      content: "I prefer dark roast coffee every morning",
      domain: "preferences",
      confidence: 0.95,
      source_type: "conversation",
    });

    // Low-confidence new fact with explicit negation
    insertSessionFact(db, {
      session_id: session.id,
      content: "I no longer prefer dark roast coffee every morning",
      domain_hint: "preferences",
      confidence: 0.3,
    });

    const result = await consolidate(db, createHeuristicProvider());

    // Supersession should fire despite confidence mismatch —
    // negation is strong belief-update evidence (see consolidate.ts comment).
    expect(result.supersessions).toBe(1);

    const { getFact } = await import("../../src/db/facts.js");
    const superseded = getFact(db, oldFact.id);
    expect(superseded!.status).toBe("superseded");
    expect(superseded!.is_latest).toBe(false);
  });

  it("surfaces dropped supersessions via openThreads when two candidates target the same prior", async () => {
    const sessionId = setupSession();

    // Seed an existing graduated fact to be targeted
    ensureDomain(db, "preferences");
    const oldCoffee = insertFact(db, {
      content: "I prefer dark roast coffee",
      domain: "preferences",
      source_type: "conversation",
    });

    // Two new session facts both targeting the coffee prior with negation.
    // No inline punctuation — the heuristic tokeniser splits on whitespace only,
    // so "coffee," would be a different token from "coffee".
    insertSessionFact(db, {
      session_id: sessionId,
      content: "I no longer prefer dark roast coffee I prefer tea",
      domain_hint: "preferences",
    });
    insertSessionFact(db, {
      session_id: sessionId,
      content: "I stopped drinking dark roast coffee entirely",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, createHeuristicProvider());

    // Exactly one supersession fires — the other is a conflict
    expect(result.supersessions).toBe(1);
    // Both facts still graduate (the loser as a plain insert)
    expect(result.factsGraduated).toBe(2);
    // The loser's conflict is surfaced in openThreads
    const conflictThreads = result.openThreads.filter((t: string) =>
      t.toLowerCase().includes("conflict"),
    );
    expect(conflictThreads.length).toBeGreaterThanOrEqual(1);
    // The conflict message references the targeted prior
    expect(conflictThreads[0]).toContain("dark roast coffee");

    // Old coffee is now superseded (by the winner)
    const { getFact } = await import("../../src/db/facts.js");
    const oldState = getFact(db, oldCoffee.id);
    expect(oldState!.status).toBe("superseded");
  });

  it("serialises concurrent consolidate calls via advisory lock", async () => {
    const sessionId = setupSession();

    // Seed enough session_facts to make consolidation do real work
    for (let i = 0; i < 3; i++) {
      insertSessionFact(db, {
        session_id: sessionId,
        content: `I like hobby number ${i}`,
        domain_hint: "preferences",
      });
    }

    const [r1, r2] = await Promise.all([
      consolidate(db, createHeuristicProvider()),
      consolidate(db, createHeuristicProvider()),
    ]);

    // Exactly one succeeds, one is skipped by the advisory lock
    const succeeded = [r1, r2].filter((r: any) => !r.skipped);
    const skipped = [r1, r2].filter((r: any) => r.skipped);
    expect(succeeded).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].skipReason).toMatch(/in progress/i);
    // The one that ran did process the facts
    expect(succeeded[0].factsIn).toBe(3);
  });

  it("upsertEntityEdge strengthens on repeated calls (saturating potentiation)", async () => {
    const { createEntity, upsertEntityEdge } = await import("../../src/db/entities.js");
    const alice = createEntity(db, { type: "person", name: "Alice" });
    const bob = createEntity(db, { type: "person", name: "Bob" });

    // Consolidation code canonicalises (smaller id first) before calling
    // upsertEntityEdge. The function itself trusts the caller's ordering.
    const [a, b] = alice.id < bob.id ? [alice.id, bob.id] : [bob.id, alice.id];

    upsertEntityEdge(db, a, b, "co_mentioned");
    upsertEntityEdge(db, a, b, "co_mentioned"); // Same direction — should strengthen, not duplicate

    // Verify exactly one row exists
    const rows = db
      .prepare(`SELECT * FROM entity_edges WHERE relationship = 'co_mentioned'`)
      .all() as Array<{ from_entity: string; to_entity: string; strength: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].from_entity).toBe(a);
    expect(rows[0].to_entity).toBe(b);
    // Strength should have been updated (started at ~0.3, now ~0.51 per saturating curve)
    expect(rows[0].strength).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Domain validation
// ---------------------------------------------------------------------------

describe("domain validation at graduation", () => {
  /** A provider that returns whatever domain it is told to — as an LLM might. */
  function providerReturning(domain: string) {
    const base = createHeuristicProvider();
    return {
      ...base,
      async classifyFacts(facts: Array<{ id: string; content: string }>) {
        return facts.map((f) => ({
          id: f.id,
          content: f.content,
          domain,
          subdomain: null,
        }));
      },
    };
  }

  it("coerces an unknown domain from a provider rather than minting it", async () => {
    // The real failure mode: an LLM answers "health" instead of "medical". The
    // output schema is a free string, so nothing upstream stops it. Left alone,
    // the fact is stored under a domain that get_profile, get_preferences and
    // memory://profile never query — present in the stats, unreachable forever.
    const sessionId = setupSession();
    insertSessionFact(db, {
      session_id: sessionId,
      content: "The user is allergic to peanuts",
      domain_hint: null,
    });

    const result = await consolidate(db, providerReturning("health") as never);
    expect(result.factsGraduated).toBe(1);

    // The fact must be stored under a real domain, not an invented one...
    const rows = db.prepare(`SELECT domain FROM facts`).all() as Array<{ domain: string }>;
    expect(rows[0].domain).toBe("general");
    // ...and no phantom domain may appear in the registry table.
    const domains = db.prepare(`SELECT name FROM domains`).all() as Array<{ name: string }>;
    expect(domains.map((d) => d.name)).not.toContain("health");
  });

  it("normalises a known domain's casing instead of forking it", async () => {
    const sessionId = setupSession();
    insertSessionFact(db, {
      session_id: sessionId,
      content: "The user prefers dark roast coffee",
      domain_hint: null,
    });

    await consolidate(db, providerReturning("Preferences") as never);

    const rows = db.prepare(`SELECT domain FROM facts`).all() as Array<{ domain: string }>;
    expect(rows[0].domain).toBe("preferences");
    const domains = db.prepare(`SELECT name FROM domains`).all() as Array<{ name: string }>;
    expect(domains.map((d) => d.name)).not.toContain("Preferences");
  });

  it("still honours a valid domain from a provider", async () => {
    const sessionId = setupSession();
    insertSessionFact(db, {
      session_id: sessionId,
      content: "The user is working on the Acme project",
      domain_hint: null,
    });

    await consolidate(db, providerReturning("work") as never);

    const rows = db.prepare(`SELECT domain FROM facts`).all() as Array<{ domain: string }>;
    expect(rows[0].domain).toBe("work");
  });
});
