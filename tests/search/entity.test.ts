import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const dbMod = await import("../../src/db/index.js");
const { lookupNamedSubject } = await import("../../src/search/entity.js");
const { SUBJECT_OF } = await import("../../src/db/entities.js");

let db: Db;

beforeEach(async () => {
  db = dbMod.openDatabase(":memory:");
  await dbMod.applySchema(db);
});

afterEach(async () => {
  await dbMod.closeDatabase(db);
});

describe("lookupNamedSubject", () => {
  it("returns subject facts first when the entity exists", async () => {
    const robin = await dbMod.createEntity(db, { type: "person", name: "Robin" });
    const about = await dbMod.insertFact(db, {
      content: "Robin leads the Atlas migration",
      domain: "work",
      source_type: "conversation",
      importance: 0.4,
    });
    const mention = await dbMod.insertFact(db, {
      content: "Alex's transfer was approved by Robin",
      domain: "work",
      source_type: "conversation",
      importance: 0.9,
    });
    await dbMod.linkFactEntity(db, about.id, robin.id, SUBJECT_OF);
    await dbMod.linkFactEntity(db, mention.id, robin.id, "approver");

    const lookup = await lookupNamedSubject(db, "Robin");
    expect(lookup.found).toBe(true);
    expect(lookup.entity?.id).toBe(robin.id);
    expect(lookup.facts.map((f) => f.id)).toEqual([about.id, mention.id]);
    expect(lookup.facts[0].is_subject).toBe(true);
    expect(lookup.facts[1].is_subject).toBe(false);
  });

  it("returns mentioning facts when there is no entity row", async () => {
    await dbMod.insertFact(db, {
      content: "The Atlas migration ships in March",
      domain: "work",
      source_type: "conversation",
    });

    const lookup = await lookupNamedSubject(db, "Atlas");
    expect(lookup.found).toBe(false);
    expect(lookup.entity).toBeNull();
    expect(lookup.facts.length).toBeGreaterThanOrEqual(1);
    expect(lookup.facts[0].content).toMatch(/Atlas/);
    expect(lookup.facts.every((f) => f.is_subject === false)).toBe(true);
  });

  it("does not search when a type filter misses", async () => {
    await dbMod.createEntity(db, { type: "project", name: "Mercury" });
    await dbMod.insertFact(db, {
      content: "Mercury is the payments project",
      domain: "work",
      source_type: "conversation",
    });

    const lookup = await lookupNamedSubject(db, "Mercury", "person");
    expect(lookup.found).toBe(false);
    expect(lookup.facts).toEqual([]);
  });

  it("returns empty when nothing is known", async () => {
    const lookup = await lookupNamedSubject(db, "Nobody");
    expect(lookup.found).toBe(false);
    expect(lookup.facts).toEqual([]);
    expect(lookup.relationships).toEqual([]);
  });
});
