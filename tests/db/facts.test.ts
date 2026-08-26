import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const {
  insertFact,
  getFact,
  getFactsByDomain,
  getFactsByEntity,
  getFactsAsOfSystemTime,
  parseSystemTime,
  supersedeFact,
  keywordSearch,
  sanitiseFtsQuery,
  incrementFactAccess,
} = await import("../../src/db/facts.js");

/** Spin until the ISO clock is strictly after `iso` so as-of tests can split instants. */
function waitUntilAfter(iso: string): void {
  while (new Date().toISOString() <= iso) {
    /* millisecond clock */
  }
}
const { createEntity, linkFactEntity } = await import("../../src/db/entities.js");

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe("facts", () => {
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
      content: "Named Alex",
      domain: "profile",
      subdomain: "identity",
      source_type: "explicit",
    });

    const locationFacts = getFactsByDomain(db, "profile", "location");
    expect(locationFacts).toHaveLength(1);
    expect(locationFacts[0].content).toBe("Lives in Lisbon");
  });

  it("getFactsByDomain returns facts in created_at DESC order (B1)", async () => {
    const first = insertFact(db, {
      content: "First fact inserted",
      domain: "profile",
      source_type: "explicit",
    });
    // Ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 10));
    const second = insertFact(db, {
      content: "Second fact inserted",
      domain: "profile",
      source_type: "explicit",
    });

    const facts = getFactsByDomain(db, "profile");
    expect(facts).toHaveLength(2);
    // Newest first
    expect(facts[0].id).toBe(second.id);
    expect(facts[1].id).toBe(first.id);
  });

  it("getFactsByEntity returns facts linked to an entity", () => {
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
    expect(facts[0].is_latest).toBe(true);
  });
});

describe("supersession", () => {
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
    // Simple mode — the default — never writes the fourth clock.
    expect(oldFact!.system_retired_at).toBeNull();
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

describe("keyword search (FTS5)", () => {
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

describe("access tracking", () => {
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

describe("sanitiseFtsQuery", () => {
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

describe("bitemporal valid_from", () => {
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

describe("system_retired_at and as-of system time", () => {
  it("supersedeFact leaves system_retired_at null unless retireSystemTime is set", () => {
    const old = insertFact(db, {
      content: "Prefers tea",
      domain: "preferences",
      source_type: "explicit",
    });
    supersedeFact(db, old.id, {
      content: "Prefers coffee",
      domain: "preferences",
      source_type: "explicit",
    });
    expect(getFact(db, old.id)!.system_retired_at).toBeNull();
  });

  it("retireSystemTime stamps system_retired_at on the old fact to the same instant as valid_until", () => {
    const old = insertFact(db, {
      content: "Prefers tea",
      domain: "preferences",
      source_type: "explicit",
    });
    const replacement = supersedeFact(
      db,
      old.id,
      {
        content: "Prefers coffee",
        domain: "preferences",
        source_type: "explicit",
      },
      { retireSystemTime: true },
    );
    const retired = getFact(db, old.id)!;
    expect(retired.system_retired_at).toBe(retired.valid_until);
    expect(retired.system_retired_at).toBe(replacement.created_at);
    expect(replacement.system_retired_at).toBeNull();
  });

  it("getFactsAsOfSystemTime returns the fact believed at each instant in a chain", () => {
    const a = insertFact(db, {
      content: "Version A",
      domain: "profile",
      source_type: "explicit",
    });
    waitUntilAfter(a.created_at);
    const b = supersedeFact(
      db,
      a.id,
      { content: "Version B", domain: "profile", source_type: "explicit" },
      { retireSystemTime: true },
    );
    waitUntilAfter(b.created_at);
    const c = supersedeFact(
      db,
      b.id,
      { content: "Version C", domain: "profile", source_type: "explicit" },
      { retireSystemTime: true },
    );

    expect(b.created_at > a.created_at).toBe(true);
    expect(c.created_at > b.created_at).toBe(true);

    const atA = getFactsAsOfSystemTime(db, a.created_at).map((f) => f.id);
    expect(atA).toEqual([a.id]);

    const atB = getFactsAsOfSystemTime(db, b.created_at).map((f) => f.id);
    expect(atB).toEqual([b.id]);

    const atC = getFactsAsOfSystemTime(db, c.created_at).map((f) => f.id);
    expect(atC).toEqual([c.id]);

    const beforeA = getFactsAsOfSystemTime(db, "2000-01-01T00:00:00.000Z");
    expect(beforeA).toHaveLength(0);
  });

  it("as-of in simple mode includes superseded facts because system_retired_at is null", () => {
    // Why the read is gated on bi-temporal mode: without the fourth clock,
    // "believed at T" cannot tell a replaced fact from one still held.
    const old = insertFact(db, {
      content: "Prefers tea",
      domain: "preferences",
      source_type: "explicit",
    });
    waitUntilAfter(old.created_at);
    const replacement = supersedeFact(db, old.id, {
      content: "Prefers coffee",
      domain: "preferences",
      source_type: "explicit",
    });
    const believed = getFactsAsOfSystemTime(db, replacement.created_at).map(
      (f) => f.id,
    );
    expect(believed).toContain(old.id);
    expect(believed).toContain(replacement.id);
  });

  it("keywordSearch as-of finds a superseded fact the system still held then", () => {
    const old = insertFact(db, {
      content: "User lives in Lisbon",
      domain: "profile",
      source_type: "explicit",
    });
    waitUntilAfter(old.created_at);
    supersedeFact(
      db,
      old.id,
      {
        content: "User lives in Manchester",
        domain: "profile",
        source_type: "explicit",
      },
      { retireSystemTime: true },
    );

    const current = keywordSearch(db, "Lisbon");
    expect(current).toHaveLength(0);

    const asOf = keywordSearch(db, "Lisbon", 20, {
      asOfSystemTime: old.created_at,
    });
    expect(asOf).toHaveLength(1);
    expect(asOf[0].fact.id).toBe(old.id);
  });

  it("parseSystemTime rejects values that are not an ISO date", () => {
    expect(() => parseSystemTime("coffee")).toThrow(/ISO 8601/);
    expect(() => parseSystemTime("")).toThrow(/ISO 8601/);
    expect(parseSystemTime("2026-03-15T12:00:00Z")).toBe(
      "2026-03-15T12:00:00.000Z",
    );
  });
});

describe("sanitiseFtsQuery — adversarial inputs", () => {
  // Every case must: (a) not throw when passed to keywordSearch via MATCH,
  // and (b) for non-empty inputs with a matching fact, actually return it.
  it("empty string produces empty sanitised output", () => {
    expect(sanitiseFtsQuery("")).toBe("");
  });

  it("whitespace-only produces empty sanitised output", () => {
    expect(sanitiseFtsQuery("   \t\n  ")).toBe("");
  });

  it("single character term wraps to a literal quoted token", () => {
    expect(sanitiseFtsQuery("a")).toBe('"a"');
  });

  it("apostrophe inside a term does not break FTS5 MATCH", () => {
    insertFact(db, {
      content: "I'm allergic to peanuts",
      domain: "medical",
      source_type: "conversation",
    });
    const sanitised = sanitiseFtsQuery("I'm allergic");
    expect(() => keywordSearch(db, sanitised)).not.toThrow();
    const results = keywordSearch(db, sanitised);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("wildcard char (*) is quoted to prevent prefix expansion", () => {
    insertFact(db, {
      content: "I love coffee beans",
      domain: "preferences",
      source_type: "conversation",
    });
    // The sanitiser wraps in quotes but does not strip the *. FTS5 will not
    // treat it as a prefix operator when quoted. Must not throw.
    const sanitised = sanitiseFtsQuery("coffee*");
    expect(() => keywordSearch(db, sanitised)).not.toThrow();
  });

  it("FTS5 boolean operators AND/OR/NOT are treated as literals", () => {
    insertFact(db, {
      content: "I prefer tea AND coffee equally",
      domain: "preferences",
      source_type: "conversation",
    });
    const sanitised = sanitiseFtsQuery("AND OR NOT");
    expect(() => keywordSearch(db, sanitised)).not.toThrow();
  });

  it("embedded double-quote is stripped from the term", () => {
    // Sanitiser strips inner " to avoid unbalanced quotes breaking the parser.
    const sanitised = sanitiseFtsQuery('quote"middle');
    expect(sanitised).toBe('"quotemiddle"');
    expect(() => keywordSearch(db, sanitised)).not.toThrow();
  });

  it("unicode term with accent is preserved and searchable", () => {
    insertFact(db, {
      content: "I love café culture in Paris",
      domain: "preferences",
      source_type: "conversation",
    });
    const sanitised = sanitiseFtsQuery("café");
    expect(() => keywordSearch(db, sanitised)).not.toThrow();
    const results = keywordSearch(db, sanitised);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
