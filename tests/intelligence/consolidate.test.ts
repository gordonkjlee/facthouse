import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

// ---------------------------------------------------------------------------
// Guard: skip when native bindings are unavailable
// ---------------------------------------------------------------------------


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const { insertFact, getFactsByDomain } = await import("../../src/db/facts.js");
const { findEntity, getSelfEntity, ensureSelfEntity, getFactsBySubject } = await import("../../src/db/entities.js");
const { ensureDomain } = await import("../../src/db/domains.js");
const { getFactsMissingEmbeddings, countEmbeddings } = await import("../../src/db/embeddings.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupSession(): Promise<string> {
  const session = await createSession(db, {
    source_tool: "test-client",
    project: "openmemory",
  });
  return session.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


/**
 * A provider that reports a known entity for every fact.
 *
 * These tests used to lean on the heuristic's `my partner Robin` regex to
 * produce an entity. That regex is gone — a personal ontology hardcoded in a
 * general engine — so the fallback extracts nothing. Which is fine: these tests
 * are about what *consolidation* does with entities it is given (create, dedup,
 * link, edge), not about whether a regex can find one.
 */
function providerReturningEntity(
  name: string,
  relationship = "mentioned_in",
  type = "person",
) {
  const base = createHeuristicProvider(PERSONAL_VOCABULARY);
  return {
    ...base,
    async extractEntities(facts: Array<{ id: string }>) {
      const map = new Map<string, Array<{ name: string; type: string; relationship: string }>>();
      for (const f of facts) map.set(f.id, [{ name, type, relationship }]);
      return map;
    },
  } as never;
}

describe("consolidation pipeline", () => {
  it("consolidates session_facts into graduated facts", async () => {
    const sessionId = await setupSession();
    const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

    await insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
      domain_hint: "profile",
    });
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });
    await insertSessionFact(db, {
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
    const profileFacts = await getFactsByDomain(db, "profile");
    expect(profileFacts.length).toBeGreaterThanOrEqual(1);
    expect(profileFacts.some((f: any) => f.content.includes("Alex"))).toBe(true);

    const prefFacts = await getFactsByDomain(db, "preferences");
    expect(prefFacts.length).toBeGreaterThanOrEqual(1);

    const medFacts = await getFactsByDomain(db, "medical");
    expect(medFacts.length).toBeGreaterThanOrEqual(1);

    // Untimed extracts must not look as if they became true at graduation.
    expect(profileFacts.every((f) => f.valid_from === null)).toBe(true);
    expect(prefFacts.every((f) => f.valid_from === null)).toBe(true);
    expect(medFacts.every((f) => f.valid_from === null)).toBe(true);
  });

  it("graduates a stated valid_from_hint and leaves an untimed fact undated", async () => {
    const sessionId = await setupSession();
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user went to the beach on 25 August 2026",
      domain_hint: "profile",
      valid_from_hint: "2026-08-25T00:00:00.000Z",
    });
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user worked in a bar when younger",
      domain_hint: "work",
    });

    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));

    const beach = (await getFactsByDomain(db, "profile")).find((f) =>
      f.content.includes("beach"),
    );
    const bar = (await getFactsByDomain(db, "work")).find((f) => f.content.includes("bar"));
    expect(beach).toBeDefined();
    expect(bar).toBeDefined();
    expect(beach!.valid_from).toBe("2026-08-25T00:00:00.000Z");
    expect(bar!.valid_from).toBeNull();
  });

  it("creates entities from facts mentioning people", async () => {
    const sessionId = await setupSession();
    const provider = providerReturningEntity("Robin", "partner_of");

    await insertSessionFact(db, {
      session_id: sessionId,
      content: "my partner Robin loves sushi",
    });

    const result = await consolidate(db, provider);

    expect(result.skipped).toBe(false);
    expect(result.entitiesCreated).toBeGreaterThanOrEqual(1);

    const entity = await findEntity(db, "Robin", "person");
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe("Robin");
  });

  it("links entities to graduated facts", async () => {
    const sessionId = await setupSession();
    const provider = providerReturningEntity("Robin", "partner_of");

    await insertSessionFact(db, {
      session_id: sessionId,
      content: "my partner Robin loves sushi",
    });

    const result = await consolidate(db, provider);

    expect(result.entitiesLinked).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates exact content matches (reconcile returns noop)", async () => {
    const sessionId = await setupSession();
    const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

    // Pre-insert a graduated fact
    await ensureDomain(db, "profile");
    await insertFact(db, {
      content: "My name is Alex",
      domain: "profile",
      source_type: "conversation",
    });

    // Insert the same content as a session fact
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    const result = await consolidate(db, provider);

    expect(result.factsIn).toBe(1);
    expect(result.factsRejected).toBe(1);
    expect(result.factsGraduated).toBe(0);
  });

  it("skips when lock is held by another process", async () => {
    const sessionId = await setupSession();
    const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

    await insertSessionFact(db, {
      session_id: sessionId,
      content: "Some fact",
    });

    // Manually insert a lock row with a recent timestamp
    await db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at) VALUES (1, ?, ?)`,
    ).run("other-process", new Date().toISOString());

    const result = await consolidate(db, provider);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("Another consolidation");
  });

  it("is idempotent: second consolidation on same data returns 0 facts_in", async () => {
    const sessionId = await setupSession();
    const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

    await insertSessionFact(db, {
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
    const sessionId = await setupSession();
    const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

    await insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
      domain_hint: "profile",
    });
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, provider);

    expect(result.summary).not.toBeNull();
    expect(result.summary).toContain("2 facts");
  });

  it("creates consolidation record in consolidations table", async () => {
    const sessionId = await setupSession();
    const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

    await insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    const result = await consolidate(db, provider);

    const record = (await db
      .prepare(`SELECT * FROM consolidations WHERE id = ?`)
      .get(result.consolidationId)) as any;

    expect(record).toBeDefined();
    expect(record.facts_in).toBe(1);
    expect(record.facts_graduated).toBe(1);
    expect(record.session_id).toBe(sessionId);
  });

  it("releases lock after completion", async () => {
    const sessionId = await setupSession();
    const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

    await insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    await consolidate(db, provider);

    const lockRow = (await db
      .prepare(`SELECT * FROM consolidation_lock WHERE id = 1`)
      .get());

    expect(lockRow).toBeUndefined();
  });

  it("sets consolidation_id on claimed session_facts", async () => {
    const sessionId = await setupSession();
    const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

    await insertSessionFact(db, {
      session_id: sessionId,
      content: "My name is Alex",
    });

    const result = await consolidate(db, provider);

    const facts = (await db
      .prepare(`SELECT * FROM session_facts WHERE session_id = ?`)
      .all(sessionId)) as any[];

    expect(facts).toHaveLength(1);
    expect(facts[0].consolidation_id).toBe(result.consolidationId);
  });

  it("unclaims session_facts when the pipeline throws mid-run", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertSessionFact(db, { session_id: session.id, content: "will be unclaimed" });

    // Provider that always throws during classification
    const failingProvider = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      classifyFacts: async () => {
        throw new Error("simulated provider failure");
      },
    };

    await expect(consolidate(db, failingProvider)).rejects.toThrow("simulated provider failure");

    // Facts should be unclaimed (consolidation_id = NULL), not orphaned
    const facts = (await db
      .prepare(`SELECT * FROM session_facts WHERE session_id = ?`)
      .all(session.id)) as any[];
    expect(facts).toHaveLength(1);
    expect(facts[0].consolidation_id).toBeNull();

    // Lock must have been released — otherwise next consolidation would skip
    const { getLockState } = await import("../../src/db/consolidation-lock.js");
    expect(await getLockState(db)).toBeNull();

    // Next consolidation should pick them up
    const retry = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(retry.factsIn).toBe(1);
  });

  it("handles two new facts targeting the same existing fact for supersession", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });

    // Pre-existing fact that two new ones will try to supersede
    await insertFact(db, {
      content: "I prefer dark roast coffee every morning",
      domain: "preferences",
      source_type: "conversation",
    });

    // Two new session facts both contradicting the existing one
    await insertSessionFact(db, {
      session_id: session.id,
      content: "I no longer prefer dark roast coffee every morning",
      domain_hint: "preferences",
    });
    await insertSessionFact(db, {
      session_id: session.id,
      content: "I stopped drinking dark roast coffee every morning",
      domain_hint: "preferences",
    });

    // Should not throw — dedup prevents transaction rollback
    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));

    expect(result.skipped).toBe(false);
    expect(result.factsGraduated).toBe(2);
    // Exactly one supersession (the first candidate wins)
    expect(result.supersessions).toBe(1);
  });

  it("consolidation record session_id is null when batch spans multiple sessions", async () => {
    const s1 = await createSession(db, { source_tool: "test", project: null });
    const s2 = await createSession(db, { source_tool: "test", project: null });

    await insertSessionFact(db, { session_id: s1.id, content: "fact from session 1", domain_hint: "profile" });
    await insertSessionFact(db, { session_id: s2.id, content: "fact from session 2", domain_hint: "profile" });

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.factsIn).toBe(2);

    const record = (await db
      .prepare("SELECT session_id FROM consolidations WHERE id = ?")
      .get(result.consolidationId)) as { session_id: string | null };

    expect(record.session_id).toBeNull();
  });

  it("deduplicates identical content across sessions within one batch (D3)", async () => {
    const s1 = await createSession(db, { source_tool: "test", project: null });
    const s2 = await createSession(db, { source_tool: "test", project: null });

    // Same content in two sessions — per-session hash dedup doesn't catch this
    await insertSessionFact(db, {
      session_id: s1.id,
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });
    await insertSessionFact(db, {
      session_id: s2.id,
      content: "I prefer dark roast coffee",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.factsIn).toBe(2);
    // Only one graduates — the second is rejected as intra-batch duplicate
    expect(result.factsGraduated).toBe(1);
    expect(result.factsRejected).toBe(1);

    // Verify: exactly one active fact in the preferences domain
    const facts = await getFactsByDomain(db, "preferences");
    expect(facts).toHaveLength(1);
  });

  it("reconciles cross-domain duplicates via domain scan (not FTS5)", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });

    // Pre-existing fact — long enough that FTS5 AND-semantics would miss paraphrases
    await insertFact(db, {
      content: "I prefer dark roast Ethiopian coffee from Blue Bottle in the morning",
      domain: "preferences",
      source_type: "conversation",
    });

    // New fact with identical content should be deduplicated by heuristic reconcile
    await insertSessionFact(db, {
      session_id: session.id,
      content: "I prefer dark roast Ethiopian coffee from Blue Bottle in the morning",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    // Heuristic reconcile returns "noop" on exact content match
    expect(result.factsRejected).toBe(1);
    expect(result.factsGraduated).toBe(0);
  });

  it("graduated facts have a source_id linking back to provenance (C1)", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertSessionFact(db, {
      session_id: session.id,
      content: "I prefer dark roast",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.factsGraduated).toBe(1);

    // Graduated fact should have source_id set
    const graduatedFact = (await db
      .prepare(`SELECT * FROM facts WHERE source_id IS NOT NULL LIMIT 1`)
      .get()) as any;
    expect(graduatedFact).toBeTruthy();
    expect(graduatedFact.source_id).toBeTruthy();

    // Source should exist and contain session_fact_id in metadata
    const source = (await db
      .prepare(`SELECT * FROM sources WHERE id = ?`)
      .get(graduatedFact.source_id)) as any;
    expect(source).toBeTruthy();
    expect(source.type).toBe("session-fact");
    const metadata = JSON.parse(source.metadata);
    expect(metadata.session_fact_id).toBeTruthy();
    expect(metadata.session_id).toBe(session.id);
  });

  it("low-confidence negation DOES supersede high-confidence prior (intentional)", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });

    // High-confidence existing fact
    const oldFact = await insertFact(db, {
      content: "I prefer dark roast coffee every morning",
      domain: "preferences",
      confidence: 0.95,
      source_type: "conversation",
    });

    // Low-confidence new fact with explicit negation
    await insertSessionFact(db, {
      session_id: session.id,
      content: "I no longer prefer dark roast coffee every morning",
      domain_hint: "preferences",
      confidence: 0.3,
    });

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));

    // Supersession should fire despite confidence mismatch —
    // negation is strong belief-update evidence (see consolidate.ts comment).
    expect(result.supersessions).toBe(1);

    const { getFact } = await import("../../src/db/facts.js");
    const superseded = await getFact(db, oldFact.id);
    expect(superseded!.status).toBe("superseded");
    expect(superseded!.is_latest).toBe(false);
    expect(superseded!.system_retired_at).toBeNull();
  });

  it("stamps system_retired_at on supersede when temporal mode is bitemporal", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    const oldFact = await insertFact(db, {
      content: "I prefer dark roast coffee every morning",
      domain: "preferences",
      source_type: "conversation",
    });
    await insertSessionFact(db, {
      session_id: session.id,
      content: "I no longer prefer dark roast coffee every morning",
      domain_hint: "preferences",
    });

    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {
      temporal: { mode: "bitemporal", bitemporal_since: null },
    });

    const { getFact } = await import("../../src/db/facts.js");
    const superseded = await getFact(db, oldFact.id);
    expect(superseded!.status).toBe("superseded");
    expect(superseded!.system_retired_at).toBe(superseded!.valid_until);
    expect(superseded!.system_retired_at).not.toBeNull();
  });

  it("surfaces dropped supersessions via openThreads when two candidates target the same prior", async () => {
    const sessionId = await setupSession();

    // Seed an existing graduated fact to be targeted
    await ensureDomain(db, "preferences");
    const oldCoffee = await insertFact(db, {
      content: "I prefer dark roast coffee",
      domain: "preferences",
      source_type: "conversation",
    });

    // Two new session facts both targeting the coffee prior with negation.
    // No inline punctuation — the heuristic tokeniser splits on whitespace only,
    // so "coffee," would be a different token from "coffee".
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "I no longer prefer dark roast coffee I prefer tea",
      domain_hint: "preferences",
    });
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "I stopped drinking dark roast coffee entirely",
      domain_hint: "preferences",
    });

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));

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
    const oldState = await getFact(db, oldCoffee.id);
    expect(oldState!.status).toBe("superseded");
  });

  it("serialises concurrent consolidate calls via advisory lock", async () => {
    const sessionId = await setupSession();

    // Seed enough session_facts to make consolidation do real work
    for (let i = 0; i < 3; i++) {
      await insertSessionFact(db, {
        session_id: sessionId,
        content: `I like hobby number ${i}`,
        domain_hint: "preferences",
      });
    }

    const [r1, r2] = await Promise.all([
      consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY)),
      consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY)),
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
    const alice = await createEntity(db, { type: "person", name: "Alice" });
    const bob = await createEntity(db, { type: "person", name: "Bob" });

    // Consolidation code canonicalises (smaller id first) before calling
    // upsertEntityEdge. The function itself trusts the caller's ordering.
    const [a, b] = alice.id < bob.id ? [alice.id, bob.id] : [bob.id, alice.id];

    await upsertEntityEdge(db, a, b, "co_mentioned");
    await upsertEntityEdge(db, a, b, "co_mentioned"); // Same direction — should strengthen, not duplicate

    // Verify exactly one row exists
    const rows = (await db
      .prepare(`SELECT * FROM entity_edges WHERE relationship = 'co_mentioned'`)
      .all()) as Array<{ from_entity: string; to_entity: string; strength: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].from_entity).toBe(a);
    expect(rows[0].to_entity).toBe(b);
    // Strength should have been updated (started at ~0.3, now ~0.51 per saturating curve)
    expect(rows[0].strength).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Domain handling at graduation
// ---------------------------------------------------------------------------

describe("domain handling at graduation", () => {
  /** A provider that returns whatever domain it is told to — as an LLM might. */
  function providerReturning(domain: string) {
    const base = createHeuristicProvider(PERSONAL_VOCABULARY);
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

  async function graduateWith(domain: string, content = "A synthetic fact") {
    const sessionId = await setupSession();
    await insertSessionFact(db, { session_id: sessionId, content, domain_hint: null });
    const result = await consolidate(db, providerReturning(domain) as never);
    expect(result.factsGraduated).toBe(1);
    return ((await db.prepare(`SELECT domain FROM facts`).get()) as { domain: string }).domain;
  }

  it("keeps a domain outside the core rather than flattening it", async () => {
    // The taxonomy is open beyond the core: an assistant that decides a fact
    // belongs in "fitness" knows the user better than our list does. Coercing it
    // to `general` would throw away the most informative thing about the fact.
    expect(await graduateWith("fitness")).toBe("fitness");

    const domains = (await db.prepare(`SELECT name FROM domains`).all()) as Array<{ name: string }>;
    expect(domains.map((d) => d.name)).toContain("fitness");
  });

  it("merges a spelling variant instead of forking the domain", async () => {
    // "Preferences" and "preferences" are one domain. This is the drift control:
    // canonicalise the spelling, don't police the meaning.
    expect(await graduateWith("Preferences")).toBe("preferences");

    const domains = (await db.prepare(`SELECT name FROM domains`).all()) as Array<{ name: string }>;
    expect(domains.map((d) => d.name)).not.toContain("Preferences");
  });

  it("still honours a core domain from a provider", async () => {
    expect(await graduateWith("work")).toBe("work");
  });

  it("falls back only when a provider returns no domain at all", async () => {
    expect(await graduateWith("")).toBe("general");
  });
});

describe("subject marking at graduation", () => {
  /**
   * A fact→entity link says a fact *names* something. It cannot say a fact is
   * *about* something, which is what "tell me about X" needs — and what
   * identity retrieval needs most of all, since a fact about the user
   * frequently names nobody at all.
   *
   * These assert the deterministic half of that: third-person self-reference,
   * which is how an assistant records facts about its user.
   */
  it("anchors a fact about the user to the self entity", async () => {
    const sessionId = await setupSession();
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user prefers dark mode in all editors",
      source_origin: "explicit",
    });

    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {});

    const self = await getSelfEntity(db);
    expect(self).not.toBeNull();
    const subjectFacts = await getFactsBySubject(db, self!.id);
    expect(subjectFacts).toHaveLength(1);
    expect(subjectFacts[0].content).toMatch(/dark mode/);
  });

  it("anchors a fact that names nobody, which extraction returns nothing for", async () => {
    // The case that motivates doing this outside the entity-extraction branch.
    // The heuristic provider extracts no entities at all, so if subject marking
    // hung off extraction this fact would have no anchor — and it is exactly
    // the kind of fact a profile is made of.
    const sessionId = await setupSession();
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user is allergic to shellfish",
      source_origin: "explicit",
    });

    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {});

    const self = (await getSelfEntity(db))!;
    expect(await getFactsBySubject(db, self.id)).toHaveLength(1);
  });

  it("does not anchor a fact about somebody else", async () => {
    // Create the anchor first, as init and server boot both do. Without this
    // the store has no self entity, the lookup below returns null, and the
    // assertion would pass by never running.
    const self = await ensureSelfEntity(db);

    const sessionId = await setupSession();
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "Robin leads the Atlas migration this quarter",
      source_origin: "explicit",
    });

    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {});

    expect(await getFactsBySubject(db, self.id)).toEqual([]);
    // And the fact still graduated — declining to name a subject must not drop
    // the fact along with it.
    expect((await getFactsByDomain(db, "general")).length + (await getFactsByDomain(db, "work")).length)
      .toBeGreaterThan(0);
  });

  it("keeps one self entity across repeated consolidations", async () => {
    for (const content of [
      "The user prefers dark mode",
      "The user is allergic to shellfish",
    ]) {
      const sessionId = await setupSession();
      await insertSessionFact(db, { session_id: sessionId, content, source_origin: "explicit" });
      await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {});
    }

    const count = (await db
      .prepare(`SELECT COUNT(*) AS n FROM entities WHERE is_self = 1`)
      .get()) as { n: number };
    expect(count.n).toBe(1);
    expect(await getFactsBySubject(db, (await getSelfEntity(db))!.id)).toHaveLength(2);
  });
});

describe("embedding never costs a fact", () => {
  /**
   * Semantic search is an enhancement to retrieval. A provider that is down,
   * rate-limited, or misconfigured must cost recall until the next run — never
   * a fact. Facts are already committed when embedding runs, so the only way to
   * get this wrong is to let the failure propagate.
   *
   * The retry mechanism is deliberately not a flag: a fact with no vector row
   * *is* the queue, so a failed run leaves the work correctly scheduled with no
   * bookkeeping that could drift out of step with it.
   */
  const failing = {
    model: "broken",
    dimensions: 3,
    async embed(): Promise<never> {
      throw new Error("provider unreachable");
    },
  };

  const working = (dims = 3) => ({
    model: "test-model",
    dimensions: dims,
    async embed(texts: string[]) {
      return {
        vectors: texts.map(() => Float32Array.from(Array(dims).fill(1))),
        model: "test-model",
        dimensions: dims,
      };
    },
  });

  it("graduates facts even when the embedding provider throws", async () => {
    const sessionId = await setupSession();
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user prefers dark roast coffee",
      source_origin: "explicit",
    });

    const result = await consolidate(
      db,
      createHeuristicProvider(PERSONAL_VOCABULARY),
      {},
      failing as never,
    );

    expect(result.factsGraduated).toBe(1);
    expect(result.skipped).toBe(false);
  });

  it("leaves the unembedded fact queued for the next run", async () => {
    const sessionId = await setupSession();
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user prefers dark roast coffee",
      source_origin: "explicit",
    });
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {}, failing as never);

    // The queue is the absence of a row, so a later working run finds it with
    // nothing to reset and no state to reconcile.
    expect(await getFactsMissingEmbeddings(db, "test-model", 3, 100)).toHaveLength(1);
  });

  it("a later working run backfills what the failed one missed", async () => {
    const sessionId = await setupSession();
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user prefers dark roast coffee",
      source_origin: "explicit",
    });
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {}, failing as never);
    expect(await countEmbeddings(db, "test-model", 3)).toBe(0);

    // Second run graduates nothing new — the backfill must come from the store,
    // not from what this run happened to produce.
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {}, working() as never);

    expect(await countEmbeddings(db, "test-model", 3)).toBe(1);
    expect(await getFactsMissingEmbeddings(db, "test-model", 3, 100)).toHaveLength(0);
  });

  it("drains a backlog larger than one batch in a single run", async () => {
    // batch_size bounds a request, not a run. When semantic search is switched
    // on over an existing store the whole store is backlog, and a run that
    // stopped after one batch would leave the rest embedded only if more
    // consolidations happened to occur — silently, since search still works.
    const sessionId = await setupSession();
    for (let i = 0; i < 7; i++) {
      await insertSessionFact(db, {
        session_id: sessionId,
        content: `The user prefers beverage number ${i}`,
        source_origin: "explicit",
      });
    }

    // Count requests, so this asserts batching still happens rather than the
    // limit having been removed.
    let calls = 0;
    const counting = {
      model: "test-model",
      dimensions: 3,
      async embed(texts: string[]) {
        calls++;
        expect(texts.length).toBeLessThanOrEqual(2);
        return {
          vectors: texts.map(() => Float32Array.from([1, 1, 1])),
          model: "test-model",
          dimensions: 3,
        };
      },
    };

    const result = await consolidate(
      db,
      createHeuristicProvider(PERSONAL_VOCABULARY),
      { embedding: { batch_size: 2 } as never },
      counting as never,
    );

    // Guards the premise: if dedup collapsed these to one fact there would be
    // no backlog and the test would pass without exercising anything.
    expect(result.factsGraduated).toBe(7);
    expect(await countEmbeddings(db, "test-model", 3)).toBe(7);
    expect(await getFactsMissingEmbeddings(db, "test-model", 3, 100)).toHaveLength(0);
    // One probe plus four batches of two — not one batch and a silent remainder.
    expect(calls).toBeGreaterThan(2);
  });

  it("keeps the batches it completed when the provider dies mid-backlog", async () => {
    // Progress must be durable per batch. Otherwise a large backlog against a
    // flaky provider makes no headway at all: every run redoes the same first
    // batches and loses them again at the same point.
    const sessionId = await setupSession();
    for (let i = 0; i < 7; i++) {
      await insertSessionFact(db, {
        session_id: sessionId,
        content: `The user prefers beverage number ${i}`,
        source_origin: "explicit",
      });
    }

    let calls = 0;
    const flaky = {
      model: "test-model",
      dimensions: 3,
      async embed(texts: string[]) {
        calls++;
        // Probe, batch, batch, then fall over.
        if (calls > 3) throw new Error("provider unreachable");
        return {
          vectors: texts.map(() => Float32Array.from([1, 1, 1])),
          model: "test-model",
          dimensions: 3,
        };
      },
    };

    await consolidate(
      db,
      createHeuristicProvider(PERSONAL_VOCABULARY),
      { embedding: { batch_size: 2 } as never },
      flaky as never,
    );

    // Some, not none and not all — the two batches that completed.
    expect(await countEmbeddings(db, "test-model", 3)).toBe(4);
    expect(await getFactsMissingEmbeddings(db, "test-model", 3, 100)).toHaveLength(3);
  });

  it("embeds nothing when no provider is configured", async () => {
    // The shipped default. No call, no rows, no behaviour change.
    const sessionId = await setupSession();
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user prefers dark roast coffee",
      source_origin: "explicit",
    });

    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {});

    const rows = (await db
      .prepare(`SELECT COUNT(*) AS n FROM fact_embeddings`)
      .get()) as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("provenance names one origin, not every repeat", async () => {
  /**
   * `extraction_type` distinguishes the event that stated a fact from the ones
   * that merely repeat it. The schema, the type and its doc comment have all
   * carried `corroborating` ("mentioned again") since the beginning, and no
   * code ever wrote it — every matching event was recorded as primary.
   *
   * That is not cosmetic in an agentic store, where the same tool output
   * recurs constantly: one fact in a real database claimed 145 separate events
   * as the one it came from. "Why do you believe this?" with 145 answers has
   * none.
   */
  /**
   * An extractor that returns one fact, verbatim.
   *
   * The heuristic provider deliberately extracts nothing from raw events —
   * that needs an LLM — so a test using it would assert against an empty list
   * for ever. Wrapping it keeps every other stage of the pipeline real.
   */
  const extracting = (content: string) => ({
    ...createHeuristicProvider(PERSONAL_VOCABULARY),
    async extractFactsFromEvents() {
      return { facts: [{ content, domain_hint: "preferences" }], degraded: false };
    },
  });

  const sources = async (factContent: string) =>
    (await db
      .prepare(
        `SELECT s.extraction_type AS type, e.sequence AS seq
           FROM session_fact_sources s
           JOIN session_events e ON e.id = s.event_id
           JOIN session_facts sf ON sf.id = s.session_fact_id
          WHERE sf.content = ?
          ORDER BY e.sequence ASC`,
      )
      .all(factContent)) as Array<{ type: string; seq: number }>;

  it("marks the earliest occurrence primary and later ones corroborating", async () => {
    const sessionId = await setupSession();
    const fact = "The user prefers dark roast coffee";
    // The same sentence three times, as repeated tool output would produce.
    for (let i = 0; i < 3; i++) {
      await insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "tool_result",
        role: "tool",
        content: `some surrounding output. ${fact}. more output.`,
      });
    }

    await consolidate(db, extracting(fact) as never, {
      extraction: { enabled: true } as never,
    });

    const links = await sources(fact);
    // Guards the premise: if extraction produced nothing, the assertions below
    // would pass vacuously on an empty list.
    expect(links.length).toBeGreaterThan(1);
    expect(links[0].type).toBe("primary");
    expect(links.slice(1).every((l) => l.type === "corroborating")).toBe(true);
    // Exactly one origin, whatever the number of repeats.
    expect(links.filter((l) => l.type === "primary")).toHaveLength(1);
  });

  it("still records a single occurrence as primary", async () => {
    // The common case must not become corroborating-only, which would leave a
    // fact with repeats but no stated origin.
    const sessionId = await setupSession();
    const fact = "The user prefers dark roast coffee";
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: `${fact}.`,
    });

    await consolidate(db, extracting(fact) as never, {
      extraction: { enabled: true } as never,
    });

    const links = await sources(fact);
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("primary");
  });
});

describe("extraction honours what a store told it to look at", () => {
  /**
   * `event_types`, `roles` and `min_content_length` shipped in the default
   * config and were read by nothing: extraction examined every event whatever a
   * store had configured. Three settings a user could change with no effect.
   *
   * They matter more than most, because they are the only lever over what
   * reaches the extractor. In an agentic store tool output is the bulk of the
   * input, and a user who judges theirs to be noise had no way to stop paying
   * to have it read.
   */
  function sawContents(): string[][] {
    return seen;
  }
  let seen: string[][] = [];

  const recording = () => ({
    ...createHeuristicProvider(PERSONAL_VOCABULARY),
    async extractFactsFromEvents(events: Array<{ content: string | null }>) {
      seen.push(events.map((e) => e.content ?? ""));
      return { facts: [], degraded: false };
    },
  });

  beforeEach(() => {
    seen = [];
  });

  it("skips event types the store excluded", async () => {
    const sessionId = await setupSession();
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "a sentence the user actually said",
    });
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "tool_result",
      role: "tool",
      content: "forty kilobytes of directory listing",
    });

    await consolidate(db, recording() as never, {
      extraction: { enabled: true, event_types: ["message"] } as never,
    });

    expect(sawContents()[0]).toEqual(["a sentence the user actually said"]);
  });

  it("skips roles the store excluded", async () => {
    const sessionId = await setupSession();
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "something the user said",
    });
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "assistant",
      content: "something the assistant said",
    });

    await consolidate(db, recording() as never, {
      extraction: { enabled: true, roles: ["user"] } as never,
    });

    expect(sawContents()[0]).toEqual(["something the user said"]);
  });

  it("skips events shorter than the configured minimum", async () => {
    const sessionId = await setupSession();
    for (const content of ["ok", "a properly substantial sentence about coffee"]) {
      await insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "message",
        role: "user",
        content,
      });
    }

    await consolidate(db, recording() as never, {
      extraction: { enabled: true, min_content_length: 10 } as never,
    });

    expect(sawContents()[0]).toEqual(["a properly substantial sentence about coffee"]);
  });

  it("does not report degradation when everything was filtered out", async () => {
    // A run that examined its events and found none eligible succeeded. Calling
    // it degraded would hold the watermark back for ever and grow a backlog
    // nothing could drain — the failure mode a previous fix in this file
    // eliminated.
    const sessionId = await setupSession();
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "tool_result",
      role: "tool",
      content: "excluded output",
    });

    const result = await consolidate(db, recording() as never, {
      extraction: { enabled: true, event_types: ["message"] } as never,
    });

    expect(result.extractionDegraded).toBeFalsy();
    // The extractor was never called, because nothing was eligible.
    expect(sawContents()).toHaveLength(0);
    // And the watermark moved, so these events are not reconsidered for ever.
    const wm = (await db
      .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) v FROM consolidations`)
      .get()) as { v: number };
    expect(wm.v).toBeGreaterThan(0);
  });
});

describe("extract and graduate can run separately", () => {
  const FACT = "The user prefers oat milk at Acme";

  async function eventWatermark(): Promise<number> {
    return (
      (await db
        .prepare(
          `SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`,
        )
        .get()) as { seq: number }
    ).seq;
  }

  async function sessionFactRows() {
    return (await db
      .prepare(
        `SELECT content, consolidation_id FROM session_facts ORDER BY created_at ASC`,
      )
      .all()) as Array<{ content: string; consolidation_id: string | null }>;
  }

  function extractingProvider(hooks: {
    onExtract?: () => void;
    onClassify?: () => void;
  } = {}) {
    const base = createHeuristicProvider(PERSONAL_VOCABULARY);
    return {
      ...base,
      async extractFactsFromEvents() {
        hooks.onExtract?.();
        return {
          // No domain_hint: graduate must call classifyFacts. Extract-only must not.
          facts: [{ content: FACT }],
          degraded: false,
          now: "talking about milk",
        };
      },
      async classifyFacts(
        facts: Array<{ id: string; content: string; domain_hint?: string | null }>,
      ) {
        hooks.onClassify?.();
        return base.classifyFacts(facts);
      },
    };
  }

  it("extract-only writes unclaimed session_facts, no K, and advances the watermark", async () => {
    const sessionId = await setupSession();
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: FACT,
    });

    let classifyCalls = 0;
    const result = await consolidate(
      db,
      extractingProvider({ onClassify: () => classifyCalls++ }) as never,
      { extraction: { enabled: true } as never },
      null,
      "extract",
    );

    expect(result.factsGraduated).toBe(0);
    expect(result.factsIn).toBe(1);
    expect(classifyCalls).toBe(0);
    expect(
      ((await db.prepare(`SELECT COUNT(*) AS n FROM facts`).get()) as { n: number }).n,
    ).toBe(0);

    const staged = await sessionFactRows();
    expect(staged).toHaveLength(1);
    expect(staged[0].content).toBe(FACT);
    expect(staged[0].consolidation_id).toBeNull();
    expect(await eventWatermark()).toBe(1);
  });

  it("graduate-only does not re-read events or advance the watermark past them", async () => {
    const sessionId = await setupSession();
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: FACT,
    });
    await consolidate(
      db,
      extractingProvider() as never,
      { extraction: { enabled: true } as never },
      null,
      "extract",
    );
    expect(await eventWatermark()).toBe(1);

    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "a later line that must stay unextracted",
    });

    let extractCalls = 0;
    const result = await consolidate(
      db,
      extractingProvider({ onExtract: () => extractCalls++ }) as never,
      { extraction: { enabled: true } as never },
      null,
      "graduate",
    );

    expect(extractCalls).toBe(0);
    expect(result.factsGraduated).toBe(1);
    expect(await eventWatermark()).toBe(1);

    const graduated = (await db
      .prepare(`SELECT content FROM facts`)
      .all()) as Array<{ content: string }>;
    expect(graduated).toHaveLength(1);
    expect(graduated[0].content).toBe(FACT);

    const staged = await sessionFactRows();
    expect(staged).toHaveLength(1);
    expect(staged[0].consolidation_id).toBe(result.consolidationId);
  });

  it("graduate-only with nothing pending does not pretend events were read", async () => {
    const sessionId = await setupSession();
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "unextracted chatter",
    });

    let extractCalls = 0;
    await consolidate(
      db,
      extractingProvider({ onExtract: () => extractCalls++ }) as never,
      { extraction: { enabled: true } as never },
      null,
      "graduate",
    );

    expect(extractCalls).toBe(0);
    expect(await eventWatermark()).toBe(0);
    expect(
      ((await db.prepare(`SELECT COUNT(*) AS n FROM consolidations`).get()) as { n: number })
        .n,
    ).toBe(0);
    expect(await sessionFactRows()).toHaveLength(0);
  });

  it("full still extracts and graduates in one run", async () => {
    const sessionId = await setupSession();
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: FACT,
    });

    const result = await consolidate(
      db,
      extractingProvider() as never,
      { extraction: { enabled: true } as never },
      null,
      "full",
    );

    expect(result.factsGraduated).toBe(1);
    const graduated = (await db
      .prepare(`SELECT content FROM facts`)
      .all()) as Array<{ content: string }>;
    expect(graduated).toHaveLength(1);
    expect(graduated[0].content).toBe(FACT);
    const staged = await sessionFactRows();
    expect(staged).toHaveLength(1);
    expect(staged[0].consolidation_id).toBe(result.consolidationId);
  });
});
