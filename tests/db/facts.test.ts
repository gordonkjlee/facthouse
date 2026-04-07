import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

// better-sqlite3 requires native bindings — test actual constructor, not just import.
let canLoadSqlite = false;
try {
  const Db = (await import("better-sqlite3")).default;
  const probe = new Db(":memory:");
  probe.close();
  canLoadSqlite = true;
} catch {
  // Native bindings not compiled (e.g. missing Visual Studio build tools on Windows).
}

const { openDatabase, closeDatabase } = canLoadSqlite
  ? await import("../../src/db/connection.js")
  : ({} as any);
const { applySchema } = canLoadSqlite
  ? await import("../../src/db/schema.js")
  : ({} as any);
const {
  insertFact,
  getFact,
  getFactsByDomain,
  getFactsByEntity,
  supersedeFact,
  keywordSearch,
  sanitiseFtsQuery,
  incrementFactAccess,
} = canLoadSqlite
  ? await import("../../src/db/facts.js")
  : ({} as any);
const { createEntity, linkFactEntity } = canLoadSqlite
  ? await import("../../src/db/entities.js")
  : ({} as any);

let db: Database.Database;

beforeEach(() => {
  if (!canLoadSqlite) return;
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => {
  if (!canLoadSqlite) return;
  closeDatabase(db);
});

describe.skipIf(!canLoadSqlite)("facts", () => {
  it("inserts a fact and returns it with all fields", () => {
    const fact = insertFact(db, {
      content: "User lives in Lisbon",
      domain: "profile",
      subdomain: "location",
      confidence: 0.9,
      importance: 0.8,
      source_type: "explicit",
      source_tool: "claude-code",
      source_id: "src-1",
      session_id: "sess-1",
      capture_context: "location discussion",
    });

    expect(fact.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(fact.content).toBe("User lives in Lisbon");
    expect(fact.domain).toBe("profile");
    expect(fact.subdomain).toBe("location");
    expect(fact.confidence).toBe(0.9);
    expect(fact.importance).toBe(0.8);
    expect(fact.source_type).toBe("explicit");
    expect(fact.source_tool).toBe("claude-code");
    expect(fact.source_id).toBe("src-1");
    expect(fact.status).toBe("active");
    expect(fact.superseded_by).toBeNull();
    expect(fact.valid_from).toBeTruthy();
    expect(fact.valid_until).toBeNull();
    expect(fact.system_retired_at).toBeNull();
    expect(fact.session_id).toBe("sess-1");
    expect(fact.capture_context).toBe("location discussion");
    expect(fact.access_count).toBe(0);
    expect(fact.created_at).toBeTruthy();
  });

  it("is_latest is boolean true in the returned Fact", () => {
    const fact = insertFact(db, {
      content: "Test fact",
      domain: "profile",
      source_type: "explicit",
    });

    expect(fact.is_latest).toBe(true);
    expect(typeof fact.is_latest).toBe("boolean");
  });

  it("getFact retrieves by ID", () => {
    const created = insertFact(db, {
      content: "Retrievable fact",
      domain: "profile",
      source_type: "explicit",
    });

    const found = getFact(db, created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.content).toBe("Retrievable fact");
    expect(found!.is_latest).toBe(true);
    expect(typeof found!.is_latest).toBe("boolean");
  });

  it("getFact returns null for non-existent ID", () => {
    expect(getFact(db, "non-existent")).toBeNull();
  });

  it("getFactsByDomain filters by domain and status=active, is_latest=1", () => {
    insertFact(db, {
      content: "Profile fact A",
      domain: "profile",
      source_type: "explicit",
    });
    insertFact(db, {
      content: "Profile fact B",
      domain: "profile",
      source_type: "explicit",
    });
    insertFact(db, {
      content: "Preferences fact",
      domain: "preferences",
      source_type: "explicit",
    });

    const profileFacts = getFactsByDomain(db, "profile");
    expect(profileFacts).toHaveLength(2);
    profileFacts.forEach((f: any) => {
      expect(f.domain).toBe("profile");
      expect(f.status).toBe("active");
      expect(f.is_latest).toBe(true);
    });

    const prefFacts = getFactsByDomain(db, "preferences");
    expect(prefFacts).toHaveLength(1);
  });

  it("getFactsByDomain filters by subdomain when provided", () => {
    insertFact(db, {
      content: "Lives in Lisbon",
      domain: "profile",
      subdomain: "location",
      source_type: "explicit",
    });
    insertFact(db, {
      content: "Named Gordon",
      domain: "profile",
      subdomain: "identity",
      source_type: "explicit",
    });

    const locationFacts = getFactsByDomain(db, "profile", "location");
    expect(locationFacts).toHaveLength(1);
    expect(locationFacts[0].content).toBe("Lives in Lisbon");
  });

  it("getFactsByEntity returns facts linked to an entity", () => {
    const fact = insertFact(db, {
      content: "Gordon works at Acme",
      domain: "work",
      source_type: "explicit",
    });

    const entity = createEntity(db, { type: "person", name: "Gordon" });
    linkFactEntity(db, fact.id, entity.id, "subject");

    const facts = getFactsByEntity(db, entity.id);
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe(fact.id);
    expect(facts[0].is_latest).toBe(true);
  });
});

describe.skipIf(!canLoadSqlite)("supersession", () => {
  it("supersedeFact marks old fact as superseded and creates new fact", () => {
    const old = insertFact(db, {
      content: "User lives in Lisbon",
      domain: "profile",
      source_type: "explicit",
    });

    const replacement = supersedeFact(db, old.id, {
      content: "User lives in Manchester",
      domain: "profile",
      source_type: "explicit",
    });

    expect(replacement.id).not.toBe(old.id);
    expect(replacement.content).toBe("User lives in Manchester");
    expect(replacement.status).toBe("active");
    expect(replacement.is_latest).toBe(true);

    const oldFact = getFact(db, old.id);
    expect(oldFact!.status).toBe("superseded");
    expect(oldFact!.is_latest).toBe(false);
    expect(oldFact!.superseded_by).toBe(replacement.id);
  });

  it("supersedeFact sets valid_until on old fact and valid_from on new fact", () => {
    const old = insertFact(db, {
      content: "Prefers tea",
      domain: "preferences",
      source_type: "explicit",
    });

    const replacement = supersedeFact(db, old.id, {
      content: "Prefers coffee",
      domain: "preferences",
      source_type: "explicit",
    });

    const oldFact = getFact(db, old.id);
    expect(oldFact!.valid_until).toBeTruthy();
    expect(replacement.valid_from).toBeTruthy();

    // The old fact's valid_until should match the new fact's valid_from (both set to "now")
    expect(oldFact!.valid_until).toBe(replacement.valid_from);
  });

  it("supersedeFact chain: A superseded by B, B superseded by C — only C is_latest", () => {
    const a = insertFact(db, {
      content: "Version A",
      domain: "profile",
      source_type: "explicit",
    });

    const b = supersedeFact(db, a.id, {
      content: "Version B",
      domain: "profile",
      source_type: "explicit",
    });

    const c = supersedeFact(db, b.id, {
      content: "Version C",
      domain: "profile",
      source_type: "explicit",
    });

    const factA = getFact(db, a.id);
    const factB = getFact(db, b.id);
    const factC = getFact(db, c.id);

    expect(factA!.is_latest).toBe(false);
    expect(factA!.status).toBe("superseded");
    expect(factA!.superseded_by).toBe(b.id);

    expect(factB!.is_latest).toBe(false);
    expect(factB!.status).toBe("superseded");
    expect(factB!.superseded_by).toBe(c.id);

    expect(factC!.is_latest).toBe(true);
    expect(factC!.status).toBe("active");
    expect(factC!.superseded_by).toBeNull();

    // Only C should appear in domain queries
    const domainFacts = getFactsByDomain(db, "profile");
    expect(domainFacts).toHaveLength(1);
    expect(domainFacts[0].id).toBe(c.id);
  });

  it("supersedeFact throws when oldId does not exist", () => {
    expect(() =>
      supersedeFact(db, "nonexistent-id", {
        content: "Replacement",
        domain: "profile",
        source_type: "conversation",
      }),
    ).toThrow("Cannot supersede fact 'nonexistent-id': not found");
  });
});

describe.skipIf(!canLoadSqlite)("keyword search (FTS5)", () => {
  it("keywordSearch finds facts via FTS5 BM25", () => {
    insertFact(db, {
      content: "User enjoys hiking in the mountains",
      domain: "preferences",
      source_type: "explicit",
    });
    insertFact(db, {
      content: "User is allergic to peanuts",
      domain: "medical",
      source_type: "explicit",
    });

    const results = keywordSearch(db, "hiking mountains");
    expect(results).toHaveLength(1);
    expect(results[0].fact.content).toContain("hiking");
    expect(typeof results[0].rank).toBe("number");
  });

  it("keywordSearch only returns active, is_latest facts", () => {
    const old = insertFact(db, {
      content: "User lives in Lisbon",
      domain: "profile",
      source_type: "explicit",
    });

    supersedeFact(db, old.id, {
      content: "User lives in Manchester",
      domain: "profile",
      source_type: "explicit",
    });

    const lisbonResults = keywordSearch(db, "Lisbon");
    expect(lisbonResults).toHaveLength(0);

    const manchesterResults = keywordSearch(db, "Manchester");
    expect(manchesterResults).toHaveLength(1);
    expect(manchesterResults[0].fact.is_latest).toBe(true);
  });
});

describe.skipIf(!canLoadSqlite)("access tracking", () => {
  it("incrementFactAccess increments access_count", () => {
    const fact = insertFact(db, {
      content: "Accessed fact",
      domain: "profile",
      source_type: "explicit",
    });

    expect(fact.access_count).toBe(0);

    incrementFactAccess(db, fact.id);
    const after1 = getFact(db, fact.id);
    expect(after1!.access_count).toBe(1);

    incrementFactAccess(db, fact.id);
    const after2 = getFact(db, fact.id);
    expect(after2!.access_count).toBe(2);
  });
});

describe.skipIf(!canLoadSqlite)("sanitiseFtsQuery", () => {
  it("wraps terms in double quotes", () => {
    expect(sanitiseFtsQuery("coffee tea")).toBe('"coffee" "tea"');
  });

  it("returns empty string for empty input", () => {
    expect(sanitiseFtsQuery("")).toBe("");
    expect(sanitiseFtsQuery("   ")).toBe("");
  });

  it("strips stray double quotes from terms", () => {
    expect(sanitiseFtsQuery('"unclosed')).toBe('"unclosed"');
    expect(sanitiseFtsQuery('hello "world')).toBe('"hello" "world"');
  });

  it("neutralises FTS5 operators", () => {
    expect(sanitiseFtsQuery("NOT coffee")).toBe('"NOT" "coffee"');
    expect(sanitiseFtsQuery("tea AND coffee")).toBe('"tea" "AND" "coffee"');
    expect(sanitiseFtsQuery("coffee*")).toBe('"coffee*"');
  });

  it("handles single term", () => {
    expect(sanitiseFtsQuery("aspirin")).toBe('"aspirin"');
  });
});

describe.skipIf(!canLoadSqlite)("bitemporal valid_from", () => {
  it("insertFact with valid_from: null stores null (unknown validity start)", () => {
    const fact = insertFact(db, {
      content: "Allergic to aspirin",
      domain: "medical",
      source_type: "import",
      valid_from: null,
    });

    expect(fact.valid_from).toBeNull();

    const retrieved = getFact(db, fact.id);
    expect(retrieved!.valid_from).toBeNull();
  });

  it("insertFact without valid_from defaults to now", () => {
    const before = new Date().toISOString();
    const fact = insertFact(db, {
      content: "Lives in Lisbon",
      domain: "profile",
      source_type: "conversation",
    });

    expect(fact.valid_from).not.toBeNull();
    expect(fact.valid_from! >= before).toBe(true);
  });
});
