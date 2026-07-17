/**
 * profileFacts — the one definition of "the user's identity".
 *
 * This exists because there were two. `get_profile` used structuredSearch's
 * default limit of 20 ordered by `created_at DESC`; `memory://profile` fetched
 * 200 and sorted by importance. The tool therefore returned the *newest* profile
 * facts and never consulted importance — so past 20 profile facts, the tool
 * whose description promises "core identity — name, demographics" silently
 * dropped the user's name, while the resource still showed it.
 *
 * Identity facts are the earliest captured and the most important, which is
 * exactly the combination recency-ordering discards.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const dbMod = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertFact } = await import("../../src/db/facts.js");
const { createSource } = await import("../../src/db/sources.js");
const { ensureDomain } = await import("../../src/db/domains.js");
const { profileFacts } = await import("../../src/search/profile.js");
const { buildProfile } = await import("../../src/tools/resources.js");

let db: Db;
let sourceId: string;

beforeEach(() => {
  db = dbMod.openDatabase(":memory:");
  applySchema(db);
  ensureDomain(db, "profile");
  sourceId = createSource(db, {
    type: "test",
    tool_id: null,
    raw_content: "x",
    metadata: {},
  }).id;
});

afterEach(() => dbMod.closeDatabase(db));

/** Insert a profile fact with an explicit capture time. */
function fact(content: string, importance: number, createdAt: string) {
  const f = insertFact(db, {
    content,
    domain: "profile",
    subdomain: null,
    confidence: 0.9,
    importance,
    source_type: "conversation",
    source_tool: null,
    source_id: sourceId,
    session_id: null,
    capture_context: null,
    source_quality: "explicit",
  });
  db.prepare(`UPDATE facts SET created_at = ? WHERE id = ?`).run(createdAt, f.id);
  return f;
}

/** The shape that broke it: identity captured first, then noise. */
function seedRealisticProfile() {
  fact("The user is called Alex Rivera", 0.99, "2026-01-01T00:00:00Z");
  fact("The user was born in 1990", 0.95, "2026-01-01T00:01:00Z");
  for (let i = 0; i < 25; i++) {
    fact(`Minor profile detail ${i}`, 0.2, `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`);
  }
}

describe("profileFacts", () => {
  it("keeps the user's name once the profile outgrows a page", () => {
    // The regression, precisely: 27 profile facts, the name captured first and
    // marked most important. Ordered by recency and cut at 20, the name falls
    // off the end and get_profile returns nothing but trivia.
    seedRealisticProfile();

    const facts = profileFacts(db);

    expect(facts.map((f) => f.content)).toContain("The user is called Alex Rivera");
  });

  it("ranks by importance, not recency", () => {
    // A name does not become less true for being old, and a fact captured today
    // is not more who you are.
    seedRealisticProfile();

    const top = profileFacts(db).slice(0, 2).map((f) => f.content);

    expect(top).toEqual([
      "The user is called Alex Rivera",
      "The user was born in 1990",
    ]);
  });

  it("gives the tool and the resource the same answer", () => {
    // The two surfaces disagreed for months. They now share a definition, so
    // this cannot drift without both changing.
    seedRealisticProfile();

    const fromFunction = profileFacts(db).map((f) => f.content);
    const fromResource = buildProfile(db);

    for (const content of fromFunction) {
      expect(fromResource).toContain(content);
    }
  });

  it("honours an explicit limit, still by importance", () => {
    seedRealisticProfile();
    const facts = profileFacts(db, 1);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("The user is called Alex Rivera");
  });

  it("returns nothing rather than throwing on an empty store", () => {
    expect(profileFacts(db)).toEqual([]);
  });
});
