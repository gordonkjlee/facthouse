import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const {
  createEntity,
  findEntity,
  findEntityByCanonical,
  findOrCreateEntity,
  linkFactEntity,
  getEntitiesForFacts,
  upsertEntityEdge,
  getEntityEdges,
  updateEntityAccess,
} = await import("../../src/db/entities.js");
const { insertFact, getFactsByEntity } = await import("../../src/db/facts.js");
const { ensureDomain, getDomains, createDomain } = await import("../../src/db/domains.js");
const { acquireLock, releaseLock, getLockState } = await import("../../src/db/consolidation-lock.js");

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => {
  closeDatabase(db);
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe("entities", () => {
  it("createEntity creates with canonical_name = lowercase trimmed", () => {
    const entity = createEntity(db, { type: "person", name: "  Alex Rivera  " });

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

  it("findEntity matches by canonical name (case-insensitive)", () => {
    createEntity(db, { type: "person", name: "Alex Rivera" });

    const found = findEntity(db, "ALEX RIVERA");
    expect(found).not.toBeNull();
    expect(found!.canonical_name).toBe("alex rivera");
  });

  it("findEntity with type filter", () => {
    createEntity(db, { type: "person", name: "Acme" });
    createEntity(db, { type: "organisation", name: "Acme" });

    const person = findEntity(db, "Acme", "person");
    expect(person).not.toBeNull();
    expect(person!.type).toBe("person");

    const org = findEntity(db, "Acme", "organisation");
    expect(org).not.toBeNull();
    expect(org!.type).toBe("organisation");

    // Without type filter, returns whichever comes first
    const any = findEntity(db, "Acme");
    expect(any).not.toBeNull();
  });

  it("findEntity returns null when not found", () => {
    expect(findEntity(db, "Nobody")).toBeNull();
  });

  it("findEntityByCanonical matches exact canonical name (no normalisation)", () => {
    createEntity(db, { type: "person", name: "  Alex Rivera  " });

    // Exact canonical match works
    expect(findEntityByCanonical(db, "alex rivera")).not.toBeNull();

    // Un-normalised input does NOT match — caller must normalise
    expect(findEntityByCanonical(db, "Alex Rivera")).toBeNull();
    expect(findEntityByCanonical(db, "  alex rivera  ")).toBeNull();
  });

  it("findOrCreateEntity returns existing entity if found", () => {
    const original = createEntity(db, { type: "person", name: "Alex" });
    const result = findOrCreateEntity(db, { type: "person", name: "Alex" });

    expect(result.created).toBe(false);
    expect(result.entity.id).toBe(original.id);
  });

  it("findOrCreateEntity creates new entity if not found", () => {
    const result = findOrCreateEntity(db, { type: "person", name: "Alice" });

    expect(result.created).toBe(true);
    expect(result.entity.name).toBe("Alice");
    expect(result.entity.canonical_name).toBe("alice");
  });

  it("createEntity stores and retrieves metadata", () => {
    const entity = createEntity(db, {
      type: "person",
      name: "Alex",
      metadata: { role: "developer", team: "platform" },
    });

    expect(entity.metadata).toEqual({ role: "developer", team: "platform" });

    const found = findEntity(db, "Alex", "person");
    expect(found!.metadata).toEqual({ role: "developer", team: "platform" });
  });
});

// ---------------------------------------------------------------------------
// Fact–Entity links
// ---------------------------------------------------------------------------

describe("fact-entity links", () => {
  it("linkFactEntity creates a fact-entity link", () => {
    const fact = insertFact(db, {
      content: "Alex works at Acme",
      domain: "work",
      source_type: "explicit",
    });
    const entity = createEntity(db, { type: "person", name: "Alex" });

    linkFactEntity(db, fact.id, entity.id, "subject");

    const facts = getFactsByEntity(db, entity.id);
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe(fact.id);
  });

  it("linkFactEntity is idempotent (INSERT OR IGNORE)", () => {
    const fact = insertFact(db, {
      content: "Alex works at Acme",
      domain: "work",
      source_type: "explicit",
    });
    const entity = createEntity(db, { type: "person", name: "Alex" });

    // Insert twice — should not throw
    linkFactEntity(db, fact.id, entity.id, "subject");
    linkFactEntity(db, fact.id, entity.id, "subject");

    const facts = getFactsByEntity(db, entity.id);
    expect(facts).toHaveLength(1);
  });
});

describe("getEntitiesForFacts", () => {
  it("groups entities by the fact they belong to", () => {
    const work = insertFact(db, {
      content: "Robin at Acme leads the Atlas migration",
      domain: "work",
      source_type: "explicit",
    });
    const pref = insertFact(db, {
      content: "The user prefers dark mode",
      domain: "preferences",
      source_type: "explicit",
    });
    const robin = createEntity(db, { type: "person", name: "Robin" });
    const acme = createEntity(db, { type: "organisation", name: "Acme" });

    linkFactEntity(db, work.id, robin.id, "subject");
    linkFactEntity(db, work.id, acme.id, "employer");

    const byFact = getEntitiesForFacts(db, [work.id, pref.id]);

    expect(byFact.get(work.id)!.map((e) => e.name)).toEqual(["Acme", "Robin"]);
    // A fact with no links is absent rather than mapped to an empty array —
    // the documented contract, so callers default on a miss.
    expect(byFact.has(pref.id)).toBe(false);
  });

  it("parses entity metadata rather than returning the raw JSON string", () => {
    const fact = insertFact(db, {
      content: "Robin joined in March",
      domain: "work",
      source_type: "explicit",
    });
    const robin = createEntity(db, {
      type: "person",
      name: "Robin",
      metadata: { team: "platform" },
    });
    linkFactEntity(db, fact.id, robin.id, "subject");

    const [entity] = getEntitiesForFacts(db, [fact.id]).get(fact.id)!;
    expect(entity.metadata).toEqual({ team: "platform" });
  });

  it("returns an empty map for no facts without touching the database", () => {
    // The empty-IN guard: `IN ()` is a syntax error in SQLite, so an unguarded
    // query would throw on any search that produced no results.
    expect(getEntitiesForFacts(db, []).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Entity edges
// ---------------------------------------------------------------------------

describe("entity edges", () => {
  let entityA: any;
  let entityB: any;

  beforeEach(() => {
    entityA = createEntity(db, { type: "person", name: "Alex" });
    entityB = createEntity(db, { type: "organisation", name: "Acme" });
  });

  it("upsertEntityEdge creates a new edge with initial strength", () => {
    upsertEntityEdge(db, entityA.id, entityB.id, "works_at");

    const edges = getEntityEdges(db, entityA.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_entity).toBe(entityA.id);
    expect(edges[0].to_entity).toBe(entityB.id);
    expect(edges[0].relationship).toBe("works_at");
    // Initial: 0 + (1 - 0) * 0.3 = 0.3
    expect(edges[0].strength).toBeCloseTo(0.3, 5);
    expect(edges[0].created_at).toBeTruthy();
  });

  it("upsertEntityEdge follows saturating potentiation curve", () => {
    // alpha=0.3: step 1 → 0.30, step 2 → 0.51, step 3 → 0.657
    upsertEntityEdge(db, entityA.id, entityB.id, "works_at");
    upsertEntityEdge(db, entityA.id, entityB.id, "works_at");
    upsertEntityEdge(db, entityA.id, entityB.id, "works_at");

    const edges = getEntityEdges(db, entityA.id);
    expect(edges).toHaveLength(1);
    // 0.3 → 0.3 + 0.7*0.3 = 0.51 → 0.51 + 0.49*0.3 = 0.657
    expect(edges[0].strength).toBeCloseTo(0.657, 3);
  });

  it("upsertEntityEdge is monotonically increasing and approaches 1.0", () => {
    let prevStrength = 0;
    for (let i = 0; i < 50; i++) {
      upsertEntityEdge(db, entityA.id, entityB.id, "works_at");
      const edges = getEntityEdges(db, entityA.id);
      expect(edges[0].strength).toBeGreaterThan(prevStrength);
      prevStrength = edges[0].strength;
    }
    expect(prevStrength).toBeGreaterThan(0.99);
    expect(prevStrength).toBeLessThan(1.0);
  });

  it("getEntityEdges returns edges from/to an entity", () => {
    const entityC = createEntity(db, { type: "person", name: "Alice" });

    upsertEntityEdge(db, entityA.id, entityB.id, "works_at");
    upsertEntityEdge(db, entityC.id, entityA.id, "knows");

    const edges = getEntityEdges(db, entityA.id);
    expect(edges).toHaveLength(2);

    const relationships = edges.map((e: any) => e.relationship).sort();
    expect(relationships).toEqual(["knows", "works_at"]);
  });
});

// ---------------------------------------------------------------------------
// Access tracking
// ---------------------------------------------------------------------------

describe("entity access tracking", () => {
  it("updateEntityAccess increments access_count and sets last_accessed_at", () => {
    const entity = createEntity(db, { type: "person", name: "Alex" });
    expect(entity.access_count).toBe(0);
    expect(entity.last_accessed_at).toBeNull();

    updateEntityAccess(db, entity.id);

    const found = findEntity(db, "Alex", "person");
    expect(found!.access_count).toBe(1);
    expect(found!.last_accessed_at).toBeTruthy();

    updateEntityAccess(db, entity.id);

    const found2 = findEntity(db, "Alex", "person");
    expect(found2!.access_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

describe("domains", () => {
  it("ensureDomain creates a domain", () => {
    ensureDomain(db, "profile");

    const domains = getDomains(db);
    expect(domains).toHaveLength(1);
    expect(domains[0].name).toBe("profile");
    expect(domains[0].subdomains).toEqual([]);
  });

  it("ensureDomain is idempotent", () => {
    ensureDomain(db, "profile");
    ensureDomain(db, "profile");

    const domains = getDomains(db);
    expect(domains).toHaveLength(1);
  });

  it("getDomains returns all domains with parsed subdomains", () => {
    createDomain(db, {
      name: "profile",
      subdomains: ["identity", "location", "demographics"],
    });
    createDomain(db, {
      name: "preferences",
      subdomains: ["food", "music"],
    });

    const domains = getDomains(db);
    expect(domains).toHaveLength(2);

    const profile = domains.find((d: any) => d.name === "profile");
    expect(profile!.subdomains).toEqual(["identity", "location", "demographics"]);

    const prefs = domains.find((d: any) => d.name === "preferences");
    expect(prefs!.subdomains).toEqual(["food", "music"]);
  });

  it("createDomain creates with subdomains array", () => {
    const domain = createDomain(db, {
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
  it("acquireLock acquires when no lock exists", () => {
    const acquired = acquireLock(db, "worker-1");
    expect(acquired).toBe(true);

    const state = getLockState(db);
    expect(state).not.toBeNull();
    expect(state!.holder).toBe("worker-1");
  });

  it("acquireLock returns false when lock is held by another", () => {
    acquireLock(db, "worker-1");

    const acquired = acquireLock(db, "worker-2");
    expect(acquired).toBe(false);

    // Original holder still holds it
    const state = getLockState(db);
    expect(state!.holder).toBe("worker-1");
  });

  it("acquireLock returns true when same holder re-acquires", () => {
    acquireLock(db, "worker-1");

    const acquired = acquireLock(db, "worker-1");
    expect(acquired).toBe(true);
  });

  it("releaseLock releases the lock", () => {
    acquireLock(db, "worker-1");

    releaseLock(db, "worker-1");

    const state = getLockState(db);
    expect(state).toBeNull();

    // Another worker can now acquire
    const acquired = acquireLock(db, "worker-2");
    expect(acquired).toBe(true);
  });

  it("releaseLock does not release if holder does not match", () => {
    acquireLock(db, "worker-1");

    releaseLock(db, "worker-2");

    const state = getLockState(db);
    expect(state).not.toBeNull();
    expect(state!.holder).toBe("worker-1");
  });

  it("acquireLock takes over stale lock (>2 min old)", () => {
    // Insert a lock row with a timestamp more than 2 minutes in the past
    const staleTime = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at) VALUES (1, ?, ?)`,
    ).run("stale-worker", staleTime);

    const state = getLockState(db);
    expect(state!.holder).toBe("stale-worker");

    // New worker should be able to take over
    const acquired = acquireLock(db, "fresh-worker");
    expect(acquired).toBe(true);

    const newState = getLockState(db);
    expect(newState!.holder).toBe("fresh-worker");
  });
});
