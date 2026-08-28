import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const {
  createEntity,
  findEntity,
  findEntitiesByName,
  findEntityByCanonical,
  findOrCreateEntity,
  linkFactEntity,
  getEntitiesForFacts,
  getSelfEntity,
  ensureSelfEntity,
  getFactsBySubject,
  SUBJECT_OF,
  upsertEntityEdge,
  getEntityEdges,
  updateEntityAccess,
} = await import("../../src/db/entities.js");
const { insertFact, getFactsByEntity } = await import("../../src/db/facts.js");
const { ensureDomain, getDomains, createDomain } = await import("../../src/db/domains.js");
const { acquireLock, releaseLock, getLockState } = await import("../../src/db/consolidation-lock.js");

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe("entities", () => {
  it("createEntity creates with canonical_name = lowercase trimmed", async () => {
    const entity = await createEntity(db, { type: "person", name: "  Alex Rivera  " });

    expect(entity.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(entity.name).toBe("  Alex Rivera  ");
    expect(entity.canonical_name).toBe("alex rivera");
    expect(entity.type).toBe("person");
    expect(entity.access_count).toBe(0);
    expect(entity.last_accessed_at).toBeNull();
    expect(entity.created_at).toBeTruthy();
  });

  it("findEntity matches by canonical name (case-insensitive)", async () => {
    await createEntity(db, { type: "person", name: "Alex Rivera" });

    const found = await findEntity(db, "ALEX RIVERA");
    expect(found).not.toBeNull();
    expect(found!.canonical_name).toBe("alex rivera");
  });

  it("findEntity with type filter", async () => {
    await createEntity(db, { type: "person", name: "Acme" });
    await createEntity(db, { type: "organisation", name: "Acme" });

    const person = await findEntity(db, "Acme", "person");
    expect(person).not.toBeNull();
    expect(person!.type).toBe("person");

    const org = await findEntity(db, "Acme", "organisation");
    expect(org).not.toBeNull();
    expect(org!.type).toBe("organisation");

    await db.prepare(`UPDATE entities SET created_at = ? WHERE id = ?`).run(
      "2026-01-01T00:00:00.000Z",
      org.id,
    );
    await db.prepare(`UPDATE entities SET created_at = ? WHERE id = ?`).run(
      "2026-01-02T00:00:00.000Z",
      person!.id,
    );

    // Without type filter, oldest created_at wins.
    const any = await findEntity(db, "Acme");
    expect(any).not.toBeNull();
    expect(any!.id).toBe(org.id);
  });

  it("findEntitiesByName returns every type for a canonical name, oldest first", async () => {
    const person = await createEntity(db, { type: "person", name: "Acme" });
    const org = await createEntity(db, { type: "organisation", name: "Acme" });
    await db.prepare(`UPDATE entities SET created_at = ? WHERE id = ?`).run(
      "2026-01-01T00:00:00.000Z",
      org.id,
    );
    await db.prepare(`UPDATE entities SET created_at = ? WHERE id = ?`).run(
      "2026-01-02T00:00:00.000Z",
      person.id,
    );

    const all = await findEntitiesByName(db, "ACME");
    expect(all.map((e) => e.id)).toEqual([org.id, person.id]);
    expect((await findEntityByCanonical(db, "acme"))!.id).toBe(org.id);

    const typed = await findEntitiesByName(db, "Acme", "person");
    expect(typed).toHaveLength(1);
    expect(typed[0].id).toBe(person.id);

    expect(await findEntitiesByName(db, "Nobody")).toEqual([]);
  });

  it("findEntity returns null when not found", async () => {
    expect(await findEntity(db, "Nobody")).toBeNull();
  });

  it("findEntityByCanonical matches exact canonical name (no normalisation)", async () => {
    await createEntity(db, { type: "person", name: "  Alex Rivera  " });

    // Exact canonical match works
    expect(await findEntityByCanonical(db, "alex rivera")).not.toBeNull();

    // Un-normalised input does NOT match — caller must normalise
    expect(await findEntityByCanonical(db, "Alex Rivera")).toBeNull();
    expect(await findEntityByCanonical(db, "  alex rivera  ")).toBeNull();
  });

  it("findOrCreateEntity returns existing entity if found", async () => {
    const original = await createEntity(db, { type: "person", name: "Alex" });
    const result = await findOrCreateEntity(db, { type: "person", name: "Alex" });

    expect(result.created).toBe(false);
    expect(result.entity.id).toBe(original.id);
  });

  it("findOrCreateEntity creates new entity if not found", async () => {
    const result = await findOrCreateEntity(db, { type: "person", name: "Alice" });

    expect(result.created).toBe(true);
    expect(result.entity.name).toBe("Alice");
    expect(result.entity.canonical_name).toBe("alice");
  });

  it("findOrCreateEntity still mints a sibling type (write-reuse is not this slice)", async () => {
    const first = await findOrCreateEntity(db, { type: "dbt_model", name: "stg_orders" });
    const second = await findOrCreateEntity(db, { type: "table", name: "stg_orders" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.entity.id).not.toBe(first.entity.id);
    const all = await findEntitiesByName(db, "stg_orders");
    expect(all).toHaveLength(2);
  });

  it("createEntity stores and retrieves metadata", async () => {
    const entity = await createEntity(db, {
      type: "person",
      name: "Alex",
      metadata: { role: "developer", team: "platform" },
    });

    expect(entity.metadata).toEqual({ role: "developer", team: "platform" });

    const found = await findEntity(db, "Alex", "person");
    expect(found!.metadata).toEqual({ role: "developer", team: "platform" });
  });
});

// ---------------------------------------------------------------------------
// Fact–Entity links
// ---------------------------------------------------------------------------

describe("fact-entity links", () => {
  it("linkFactEntity creates a fact-entity link", async () => {
    const fact = await insertFact(db, {
      content: "Alex works at Acme",
      domain: "work",
      source_type: "explicit",
    });
    const entity = await createEntity(db, { type: "person", name: "Alex" });

    await linkFactEntity(db, fact.id, entity.id, "subject");

    const facts = await getFactsByEntity(db, entity.id);
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe(fact.id);
  });

  it("linkFactEntity is idempotent (INSERT OR IGNORE)", async () => {
    const fact = await insertFact(db, {
      content: "Alex works at Acme",
      domain: "work",
      source_type: "explicit",
    });
    const entity = await createEntity(db, { type: "person", name: "Alex" });

    // Insert twice — should not throw
    await linkFactEntity(db, fact.id, entity.id, "subject");
    await linkFactEntity(db, fact.id, entity.id, "subject");

    const facts = await getFactsByEntity(db, entity.id);
    expect(facts).toHaveLength(1);
  });
});

describe("getEntitiesForFacts", () => {
  it("groups entities by the fact they belong to", async () => {
    const work = await insertFact(db, {
      content: "Robin at Acme leads the Atlas migration",
      domain: "work",
      source_type: "explicit",
    });
    const pref = await insertFact(db, {
      content: "The user prefers dark mode",
      domain: "preferences",
      source_type: "explicit",
    });
    const robin = await createEntity(db, { type: "person", name: "Robin" });
    const acme = await createEntity(db, { type: "organisation", name: "Acme" });

    await linkFactEntity(db, work.id, robin.id, "subject");
    await linkFactEntity(db, work.id, acme.id, "employer");

    const byFact = await getEntitiesForFacts(db, [work.id, pref.id]);

    expect(byFact.get(work.id)!.map((e) => e.name)).toEqual(["Acme", "Robin"]);
    // A fact with no links is absent rather than mapped to an empty array —
    // the documented contract, so callers default on a miss.
    expect(byFact.has(pref.id)).toBe(false);
  });

  it("parses entity metadata rather than returning the raw JSON string", async () => {
    const fact = await insertFact(db, {
      content: "Robin joined in March",
      domain: "work",
      source_type: "explicit",
    });
    const robin = await createEntity(db, {
      type: "person",
      name: "Robin",
      metadata: { team: "platform" },
    });
    await linkFactEntity(db, fact.id, robin.id, "subject");

    const [entity] = (await getEntitiesForFacts(db, [fact.id])).get(fact.id)!;
    expect(entity.metadata).toEqual({ team: "platform" });
  });

  it("returns an empty map for no facts without touching the database", async () => {
    // The empty-IN guard: `IN ()` is a syntax error in SQLite, so an unguarded
    // query would throw on any search that produced no results.
    expect((await getEntitiesForFacts(db, [])).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Entity edges
// ---------------------------------------------------------------------------

describe("entity edges", () => {
  let entityA: any;
  let entityB: any;

  beforeEach(async () => {
    entityA = await createEntity(db, { type: "person", name: "Alex" });
    entityB = await createEntity(db, { type: "organisation", name: "Acme" });
  });

  it("upsertEntityEdge creates a new edge with initial strength", async () => {
    await upsertEntityEdge(db, entityA.id, entityB.id, "works_at");

    const edges = await getEntityEdges(db, entityA.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_entity).toBe(entityA.id);
    expect(edges[0].to_entity).toBe(entityB.id);
    expect(edges[0].relationship).toBe("works_at");
    // Initial: 0 + (1 - 0) * 0.3 = 0.3
    expect(edges[0].strength).toBeCloseTo(0.3, 5);
    expect(edges[0].created_at).toBeTruthy();
  });

  it("upsertEntityEdge follows saturating potentiation curve", async () => {
    // alpha=0.3: step 1 → 0.30, step 2 → 0.51, step 3 → 0.657
    await upsertEntityEdge(db, entityA.id, entityB.id, "works_at");
    await upsertEntityEdge(db, entityA.id, entityB.id, "works_at");
    await upsertEntityEdge(db, entityA.id, entityB.id, "works_at");

    const edges = await getEntityEdges(db, entityA.id);
    expect(edges).toHaveLength(1);
    // 0.3 → 0.3 + 0.7*0.3 = 0.51 → 0.51 + 0.49*0.3 = 0.657
    expect(edges[0].strength).toBeCloseTo(0.657, 3);
  });

  it("upsertEntityEdge is monotonically increasing and approaches 1.0", async () => {
    let prevStrength = 0;
    for (let i = 0; i < 50; i++) {
      await upsertEntityEdge(db, entityA.id, entityB.id, "works_at");
      const edges = await getEntityEdges(db, entityA.id);
      expect(edges[0].strength).toBeGreaterThan(prevStrength);
      prevStrength = edges[0].strength;
    }
    expect(prevStrength).toBeGreaterThan(0.99);
    expect(prevStrength).toBeLessThan(1.0);
  });

  it("getEntityEdges returns edges from/to an entity", async () => {
    const entityC = await createEntity(db, { type: "person", name: "Alice" });

    await upsertEntityEdge(db, entityA.id, entityB.id, "works_at");
    await upsertEntityEdge(db, entityC.id, entityA.id, "knows");

    const edges = await getEntityEdges(db, entityA.id);
    expect(edges).toHaveLength(2);

    const relationships = edges.map((e: any) => e.relationship).sort();
    expect(relationships).toEqual(["knows", "works_at"]);
  });
});

// ---------------------------------------------------------------------------
// Access tracking
// ---------------------------------------------------------------------------

describe("entity access tracking", () => {
  it("updateEntityAccess increments access_count and sets last_accessed_at", async () => {
    const entity = await createEntity(db, { type: "person", name: "Alex" });
    expect(entity.access_count).toBe(0);
    expect(entity.last_accessed_at).toBeNull();

    await updateEntityAccess(db, entity.id);

    const found = await findEntity(db, "Alex", "person");
    expect(found!.access_count).toBe(1);
    expect(found!.last_accessed_at).toBeTruthy();

    await updateEntityAccess(db, entity.id);

    const found2 = await findEntity(db, "Alex", "person");
    expect(found2!.access_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

describe("domains", () => {
  it("ensureDomain creates a domain", async () => {
    await ensureDomain(db, "profile");

    const domains = await getDomains(db);
    expect(domains).toHaveLength(1);
    expect(domains[0].name).toBe("profile");
    expect(domains[0].subdomains).toEqual([]);
  });

  it("ensureDomain is idempotent", async () => {
    await ensureDomain(db, "profile");
    await ensureDomain(db, "profile");

    const domains = await getDomains(db);
    expect(domains).toHaveLength(1);
  });

  it("getDomains returns all domains with parsed subdomains", async () => {
    await createDomain(db, {
      name: "profile",
      subdomains: ["identity", "location", "demographics"],
    });
    await createDomain(db, {
      name: "preferences",
      subdomains: ["food", "music"],
    });

    const domains = await getDomains(db);
    expect(domains).toHaveLength(2);

    const profile = domains.find((d: any) => d.name === "profile");
    expect(profile!.subdomains).toEqual(["identity", "location", "demographics"]);

    const prefs = domains.find((d: any) => d.name === "preferences");
    expect(prefs!.subdomains).toEqual(["food", "music"]);
  });

  it("createDomain creates with subdomains array", async () => {
    const domain = await createDomain(db, {
      name: "medical",
      subdomains: ["allergies", "conditions"],
    });

    expect(domain.name).toBe("medical");
    expect(domain.subdomains).toEqual(["allergies", "conditions"]);
  });
});

// ---------------------------------------------------------------------------
// Consolidation lock
// ---------------------------------------------------------------------------

describe("consolidation lock", () => {
  it("acquireLock acquires when no lock exists", async () => {
    const acquired = await acquireLock(db, "worker-1");
    expect(acquired).toBe(true);

    const state = await getLockState(db);
    expect(state).not.toBeNull();
    expect(state!.holder).toBe("worker-1");
  });

  it("acquireLock returns false when lock is held by another", async () => {
    await acquireLock(db, "worker-1");

    const acquired = await acquireLock(db, "worker-2");
    expect(acquired).toBe(false);

    // Original holder still holds it
    const state = await getLockState(db);
    expect(state!.holder).toBe("worker-1");
  });

  it("acquireLock returns true when same holder re-acquires", async () => {
    await acquireLock(db, "worker-1");

    const acquired = await acquireLock(db, "worker-1");
    expect(acquired).toBe(true);
  });

  it("releaseLock releases the lock", async () => {
    await acquireLock(db, "worker-1");

    await releaseLock(db, "worker-1");

    const state = await getLockState(db);
    expect(state).toBeNull();

    // Another worker can now acquire
    const acquired = await acquireLock(db, "worker-2");
    expect(acquired).toBe(true);
  });

  it("releaseLock does not release if holder does not match", async () => {
    await acquireLock(db, "worker-1");

    await releaseLock(db, "worker-2");

    const state = await getLockState(db);
    expect(state).not.toBeNull();
    expect(state!.holder).toBe("worker-1");
  });

  it("acquireLock takes over stale lock (>2 min old)", async () => {
    // Insert a lock row with a timestamp more than 2 minutes in the past
    const staleTime = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at) VALUES (1, ?, ?)`,
    ).run("stale-worker", staleTime);

    const state = await getLockState(db);
    expect(state!.holder).toBe("stale-worker");

    // New worker should be able to take over
    const acquired = await acquireLock(db, "fresh-worker");
    expect(acquired).toBe(true);

    const newState = await getLockState(db);
    expect(newState!.holder).toBe("fresh-worker");
  });
});

describe("the self entity", () => {
  /**
   * Identity is a slot, not a value. The singleton exists before anything is
   * known about the user, because the user's name is learned *from* facts about
   * them — so an anchor that waits for a name never gets created.
   */
  it("creates a nameless singleton on a store that has none", async () => {
    expect(await getSelfEntity(db)).toBeNull();

    const self = await ensureSelfEntity(db);

    expect(self.is_self).toBe(1);
    expect((await getSelfEntity(db))!.id).toBe(self.id);
  });

  it("is idempotent — a second call returns the same row", async () => {
    const first = await ensureSelfEntity(db);
    const second = await ensureSelfEntity(db);
    expect(second.id).toBe(first.id);

    const count = (await db
      .prepare(`SELECT COUNT(*) AS n FROM entities WHERE is_self = 1`)
      .get()) as { n: number };
    expect(count.n).toBe(1);
  });

  it("cannot be duplicated, because the schema forbids it", async () => {
    // The invariant is enforced by a partial unique index rather than by
    // callers remembering to check. A convention that only ensureSelfEntity
    // respects is not an invariant.
    await ensureSelfEntity(db);
    await expect(createEntity(db, { type: "person", name: "impostor", is_self: true }))
      .rejects.toThrow();
  });

  it("does not constrain ordinary entities", async () => {
    // The index is partial. Without that, every entity with is_self = 0 would
    // collide with every other.
    await ensureSelfEntity(db);
    await createEntity(db, { type: "person", name: "Robin" });
    await createEntity(db, { type: "person", name: "Alex" });
    await createEntity(db, { type: "organisation", name: "Acme" });

    const count = (await db.prepare(`SELECT COUNT(*) AS n FROM entities`).get()) as { n: number };
    expect(count.n).toBe(4);
  });

  it("leaves entities created before the migration marked as not-self", async () => {
    // The column is added to a store that may already hold entities. Defaulting
    // them to 0 is the correct backfill — none of them was the user — and
    // getting it wrong would silently make some arbitrary person the anchor.
    const robin = await createEntity(db, { type: "person", name: "Robin" });
    expect(robin.is_self).toBe(0);
    expect(await getSelfEntity(db)).toBeNull();
  });
});

describe("getFactsBySubject", () => {
  it("returns facts about an entity, not facts that merely name it", async () => {
    // The distinction the whole subject apparatus exists for. Both facts link
    // to Robin; only one is about him.
    const about = await insertFact(db, {
      content: "Robin leads the Atlas migration",
      domain: "work",
      source_type: "explicit",
    });
    const mentions = await insertFact(db, {
      content: "Alex's transfer was approved by Robin",
      domain: "work",
      source_type: "explicit",
    });
    const robin = await createEntity(db, { type: "person", name: "Robin" });

    await linkFactEntity(db, about.id, robin.id, SUBJECT_OF);
    await linkFactEntity(db, mentions.id, robin.id, "approver");

    const subjects = await getFactsBySubject(db, robin.id);
    expect(subjects.map((f) => f.id)).toEqual([about.id]);
    // getFactsByEntity answers the other question, and still sees both.
    expect(await getFactsByEntity(db, robin.id)).toHaveLength(2);
  });

  it("excludes superseded facts", async () => {
    const fact = await insertFact(db, {
      content: "Robin leads the Atlas migration",
      domain: "work",
      source_type: "explicit",
    });
    const robin = await createEntity(db, { type: "person", name: "Robin" });
    await linkFactEntity(db, fact.id, robin.id, SUBJECT_OF);
    expect(await getFactsBySubject(db, robin.id)).toHaveLength(1);

    await db.prepare(`UPDATE facts SET status = 'superseded', is_latest = 0 WHERE id = ?`)
      .run(fact.id);

    expect(await getFactsBySubject(db, robin.id)).toEqual([]);
  });

  it("returns the most important facts first", async () => {
    // A subject's facts are a list someone will truncate.
    const robin = await createEntity(db, { type: "person", name: "Robin" });
    const minor = await insertFact(db, {
      content: "Robin prefers afternoon meetings",
      domain: "work",
      source_type: "explicit",
      importance: 0.2,
    });
    const major = await insertFact(db, {
      content: "Robin leads the Atlas migration",
      domain: "work",
      source_type: "explicit",
      importance: 0.9,
    });
    await linkFactEntity(db, minor.id, robin.id, SUBJECT_OF);
    await linkFactEntity(db, major.id, robin.id, SUBJECT_OF);

    expect((await getFactsBySubject(db, robin.id)).map((f) => f.id)).toEqual([major.id, minor.id]);
  });
});

describe("entity retrieval ranks subjects above mentions", () => {
  /**
   * Ranking rather than filtering, for the same reason a domain ranks rather
   * than gates. A subject-only query would be wrong twice: a fact naming Robin
   * as an approver is worth surfacing when asked about Robin, and no provider
   * emits subject links yet, so filtering on them would answer almost every
   * question with nothing.
   */
  async function factAbout(content: string, importance?: number) {
    return await insertFact(db, { content, domain: "work", source_type: "explicit", importance });
  }

  it("puts facts about the entity before facts that merely name it", async () => {
    const robin = await createEntity(db, { type: "person", name: "Robin" });
    // Insert the mention first so insertion order cannot produce the pass.
    const mention = await factAbout("Alex's transfer was approved by Robin", 0.9);
    const subject = await factAbout("Robin leads the Atlas migration", 0.1);
    await linkFactEntity(db, mention.id, robin.id, "approver");
    await linkFactEntity(db, subject.id, robin.id, SUBJECT_OF);

    const facts = await getFactsByEntity(db, robin.id);

    // Subject wins despite lower importance — the relationship outranks it.
    expect(facts.map((f) => f.id)).toEqual([subject.id, mention.id]);
    expect(facts[0].is_subject).toBe(true);
    expect(facts[1].is_subject).toBe(false);
  });

  it("orders by importance within each group", async () => {
    const robin = await createEntity(db, { type: "person", name: "Robin" });
    const minorSubject = await factAbout("Robin prefers afternoon meetings", 0.2);
    const majorSubject = await factAbout("Robin leads the Atlas migration", 0.9);
    await linkFactEntity(db, minorSubject.id, robin.id, SUBJECT_OF);
    await linkFactEntity(db, majorSubject.id, robin.id, SUBJECT_OF);

    expect((await getFactsByEntity(db, robin.id)).map((f) => f.id))
      .toEqual([majorSubject.id, minorSubject.id]);
  });

  it("still returns mentions when nothing has a subject link", async () => {
    // The state every existing store is in. If this regressed to subject-only,
    // entity retrieval would go silent for every fact captured before now.
    const robin = await createEntity(db, { type: "person", name: "Robin" });
    const fact = await factAbout("Alex's transfer was approved by Robin");
    await linkFactEntity(db, fact.id, robin.id, "approver");

    const facts = await getFactsByEntity(db, robin.id);
    expect(facts).toHaveLength(1);
    expect(facts[0].is_subject).toBe(false);
  });

  it("counts a fact once when an entity is linked to it twice", async () => {
    // fact_entities is keyed on (fact, entity, relationship), so one fact can
    // carry both a subject link and a mention link. Without the grouping it
    // would appear twice, and a caller would report it twice.
    const robin = await createEntity(db, { type: "person", name: "Robin" });
    const fact = await factAbout("Robin leads the Atlas migration");
    await linkFactEntity(db, fact.id, robin.id, SUBJECT_OF);
    await linkFactEntity(db, fact.id, robin.id, "lead");

    const facts = await getFactsByEntity(db, robin.id);
    expect(facts).toHaveLength(1);
    // About it if any link says so.
    expect(facts[0].is_subject).toBe(true);
  });
});
