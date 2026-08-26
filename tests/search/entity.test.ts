import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const dbMod = await import("../../src/db/index.js");
const { lookupNamedSubject } = await import("../../src/search/entity.js");
const { SUBJECT_OF } = await import("../../src/db/entities.js");

let db: Db;

beforeEach(() => {
  db = dbMod.openDatabase(":memory:");
  dbMod.applySchema(db);
});

afterEach(() => {
  dbMod.closeDatabase(db);
});

describe("lookupNamedSubject", () => {
  it("returns subject facts first when the entity exists", () => {
    const robin = dbMod.createEntity(db, { type: "person", name: "Robin" });
    const about = dbMod.insertFact(db, {
      content: "Robin leads the Atlas migration",
      domain: "work",
      source_type: "conversation",
      importance: 0.4,
    });
    const mention = dbMod.insertFact(db, {
      content: "Alex's transfer was approved by Robin",
      domain: "work",
      source_type: "conversation",
      importance: 0.9,
    });
    dbMod.linkFactEntity(db, about.id, robin.id, SUBJECT_OF);
    dbMod.linkFactEntity(db, mention.id, robin.id, "approver");

    const lookup = lookupNamedSubject(db, "Robin");
    expect(lookup.found).toBe(true);
    expect(lookup.entity?.id).toBe(robin.id);
    expect(lookup.facts.map((f) => f.id)).toEqual([about.id, mention.id]);
    expect(lookup.facts[0].is_subject).toBe(true);
    expect(lookup.facts[1].is_subject).toBe(false);
  });

  it("returns mentioning facts when there is no entity row", () => {
    dbMod.insertFact(db, {
      content: "The Atlas migration ships in March",
      domain: "work",
      source_type: "conversation",
    });

    const lookup = lookupNamedSubject(db, "Atlas");
    expect(lookup.found).toBe(false);
    expect(lookup.entity).toBeNull();
    expect(lookup.facts.length).toBeGreaterThanOrEqual(1);
    expect(lookup.facts[0].content).toMatch(/Atlas/);
    expect(lookup.facts.every((f) => f.is_subject === false)).toBe(true);
  });

  it("does not search when a type filter misses", () => {
    dbMod.createEntity(db, { type: "project", name: "Mercury" });
    dbMod.insertFact(db, {
      content: "Mercury is the payments project",
      domain: "work",
      source_type: "conversation",
    });

    const lookup = lookupNamedSubject(db, "Mercury", "person");
    expect(lookup.found).toBe(false);
    expect(lookup.facts).toEqual([]);
  });

  it("returns empty when nothing is known", () => {
    const lookup = lookupNamedSubject(db, "Nobody");
    expect(lookup.found).toBe(false);
    expect(lookup.facts).toEqual([]);
    expect(lookup.relationships).toEqual([]);
  });
});
