/**
 * keyFacts — the store's most important current facts, regardless of domain.
 *
 * This replaced `profileFacts`, which selected `domain = 'profile'`. On a general
 * engine that broke the moment a store used a different vocabulary. "The most
 * important facts" is universal where "the profile domain" is not: importance is
 * calibrated per-domain from the store's own config, so the top of the list is
 * whatever matters most *to this store* — with no engine-side opinion about
 * which domains those are.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const dbMod = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertFact } = await import("../../src/db/facts.js");
const { createSource } = await import("../../src/db/sources.js");
const { ensureDomain } = await import("../../src/db/domains.js");
const { keyFacts } = await import("../../src/search/key-facts.js");
const { buildProfile } = await import("../../src/tools/resources.js");

let db: Db;
let sourceId: string;

beforeEach(() => {
  db = dbMod.openDatabase(":memory:");
  applySchema(db);
  sourceId = createSource(db, {
    type: "test",
    tool_id: null,
    raw_content: "x",
    metadata: {},
  }).id;
});

afterEach(() => dbMod.closeDatabase(db));

/** Insert a fact with an explicit importance, domain and capture time. */
function fact(
  content: string,
  domain: string,
  importance: number,
  createdAt: string,
) {
  ensureDomain(db, domain);
  const f = insertFact(db, {
    content,
    domain,
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

describe("keyFacts", () => {
  it("ranks by importance across every domain, not by one domain", () => {
    // A corporate store: no 'profile' domain at all. The old profileFacts would
    // have returned nothing here; keyFacts returns the store's actual key facts.
    fact("The sev1 outage had a postmortem", "incidents", 0.95, "2026-01-01T00:00:00Z");
    fact("The Acme contract renews in March", "clients", 0.7, "2026-01-02T00:00:00Z");
    fact("Someone mentioned the weather", "general", 0.5, "2026-01-03T00:00:00Z");

    const top = keyFacts(db).map((f) => f.content);

    expect(top[0]).toContain("sev1 outage"); // highest importance, whatever its domain
    expect(top[top.length - 1]).toContain("weather"); // lowest
  });

  it("surfaces a personal store's identity as readily as a corporate store's incidents", () => {
    fact("The user is allergic to peanuts", "medical", 0.9, "2026-01-01T00:00:00Z");
    fact("The user is called Alex Rivera", "profile", 0.85, "2026-01-02T00:00:00Z");
    fact("The user prefers dark roast", "preferences", 0.4, "2026-01-03T00:00:00Z");

    const top = keyFacts(db).slice(0, 2).map((f) => f.content);
    expect(top[0]).toContain("allergic");
    expect(top[1]).toContain("Alex Rivera");
  });

  it("breaks importance ties by recency", () => {
    // When nothing has calibrated importance, everything sits at one weight and
    // recency is the only signal left — the honest degradation.
    fact("Older fact", "general", 0.5, "2026-01-01T00:00:00Z");
    fact("Newer fact", "general", 0.5, "2026-06-01T00:00:00Z");

    expect(keyFacts(db)[0].content).toBe("Newer fact");
  });

  it("honours an explicit limit", () => {
    fact("a", "x", 0.9, "2026-01-01T00:00:00Z");
    fact("b", "x", 0.8, "2026-01-02T00:00:00Z");
    fact("c", "x", 0.7, "2026-01-03T00:00:00Z");

    expect(keyFacts(db, 2)).toHaveLength(2);
  });

  it("returns nothing rather than throwing on an empty store", () => {
    expect(keyFacts(db)).toEqual([]);
  });

  it("feeds memory://profile — the resource shares this definition", () => {
    fact("The sev1 outage had a postmortem", "incidents", 0.95, "2026-01-01T00:00:00Z");
    const md = buildProfile(db);
    expect(md).toContain("sev1 outage");
    expect(md).toContain("# Key facts");
  });
});
