import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const dbMod = await import("../../src/db/index.js");
const { getTopicContext, lookupNamedSubject } = await import("../../src/search/entity.js");
const { SUBJECT_OF, upsertEntityEdge } = await import("../../src/db/entities.js");

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
    expect(lookup.entities.map((e) => e.id)).toEqual([robin.id]);
    expect(lookup.type_missed).toBe(false);
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

  it("unions sibling types when a type filter misses but the name exists", async () => {
    const project = await dbMod.createEntity(db, { type: "project", name: "Mercury" });
    const fact = await dbMod.insertFact(db, {
      content: "Mercury is the payments project",
      domain: "work",
      source_type: "conversation",
    });
    await dbMod.linkFactEntity(db, fact.id, project.id, SUBJECT_OF);

    const lookup = await lookupNamedSubject(db, "Mercury", "person");
    expect(lookup.found).toBe(true);
    expect(lookup.type_missed).toBe(true);
    expect(lookup.facts.map((f) => f.id)).toContain(fact.id);
    expect(lookup.entities.map((e) => e.id)).toEqual([project.id]);
  });

  it("unions facts across four type-split nodes of the same name", async () => {
    const asDbt = await dbMod.createEntity(db, { type: "dbt_model", name: "stg_orders" });
    const asModel = await dbMod.createEntity(db, { type: "model", name: "stg_orders" });
    const asTable = await dbMod.createEntity(db, { type: "table", name: "stg_orders" });
    const asHyphen = await dbMod.createEntity(db, { type: "dbt-model", name: "stg_orders" });
    const grain = await dbMod.insertFact(db, {
      content: "stg_orders is missing booked_at",
      domain: "pipeline",
      source_type: "conversation",
    });
    const modelA = await dbMod.insertFact(db, {
      content: "stg_orders grain is bookings",
      domain: "pipeline",
      source_type: "conversation",
    });
    const modelB = await dbMod.insertFact(db, {
      content: "stg_orders is the staging relation for orders",
      domain: "pipeline",
      source_type: "conversation",
    });
    const extra = await dbMod.insertFact(db, {
      content: "stg_orders lands in the orders mart",
      domain: "pipeline",
      source_type: "conversation",
    });
    const nightly = await dbMod.insertFact(db, {
      content: "stg_orders is built by the nightly job",
      domain: "pipeline",
      source_type: "conversation",
    });
    await dbMod.linkFactEntity(db, grain.id, asDbt.id, SUBJECT_OF);
    await dbMod.linkFactEntity(db, modelA.id, asModel.id, SUBJECT_OF);
    await dbMod.linkFactEntity(db, modelB.id, asModel.id, SUBJECT_OF);
    await dbMod.linkFactEntity(db, extra.id, asTable.id, SUBJECT_OF);
    await dbMod.linkFactEntity(db, nightly.id, asHyphen.id, SUBJECT_OF);

    const lookup = await lookupNamedSubject(db, "stg_orders");
    expect(lookup.found).toBe(true);
    expect(lookup.type_missed).toBe(false);
    expect(lookup.entities).toHaveLength(4);
    expect(lookup.facts.map((f) => f.id).sort()).toEqual(
      [grain.id, modelA.id, modelB.id, extra.id, nightly.id].sort(),
    );
    expect(lookup.entity?.id).toBe(asModel.id);

    const typed = await lookupNamedSubject(db, "stg_orders", "table");
    expect(typed.entity?.id).toBe(asTable.id);
    expect(typed.facts.map((f) => f.id)).toEqual([extra.id]);
    expect(typed.type_missed).toBe(false);
    expect(typed.entities.map((e) => e.id)).toEqual([asTable.id]);

    const missed = await lookupNamedSubject(db, "stg_orders", "view");
    expect(missed.found).toBe(true);
    expect(missed.type_missed).toBe(true);
    expect(missed.facts.map((f) => f.id).sort()).toEqual(
      [grain.id, modelA.id, modelB.id, extra.id, nightly.id].sort(),
    );
  });

  it("search-fills a typed miss when the name does not exist at all", async () => {
    await dbMod.insertFact(db, {
      content: "Helios is the internal name for the Atlas cutover",
      domain: "work",
      source_type: "conversation",
    });

    const lookup = await lookupNamedSubject(db, "Helios", "person");
    expect(lookup.found).toBe(false);
    expect(lookup.type_missed).toBe(false);
    expect(lookup.entity).toBeNull();
    expect(lookup.entities).toEqual([]);
    expect(lookup.facts.length).toBeGreaterThanOrEqual(1);
    expect(lookup.facts[0].content).toMatch(/Helios/);
    expect(lookup.facts.every((f) => f.is_subject === false)).toBe(true);
  });

  it("hops get_context from every type-split node, not first-match only", async () => {
    const asModel = await dbMod.createEntity(db, { type: "dbt_model", name: "stg_orders" });
    const asTable = await dbMod.createEntity(db, { type: "table", name: "stg_orders" });
    const robin = await dbMod.createEntity(db, { type: "person", name: "Robin" });
    const grain = await dbMod.insertFact(db, {
      content: "stg_orders is missing booked_at",
      domain: "pipeline",
      source_type: "conversation",
    });
    const extra = await dbMod.insertFact(db, {
      content: "stg_orders lands in the orders mart",
      domain: "pipeline",
      source_type: "conversation",
    });
    const aboutRobin = await dbMod.insertFact(db, {
      content: "Robin owns the orders mart",
      domain: "work",
      source_type: "conversation",
    });
    await dbMod.linkFactEntity(db, grain.id, asModel.id, SUBJECT_OF);
    await dbMod.linkFactEntity(db, extra.id, asTable.id, SUBJECT_OF);
    await dbMod.linkFactEntity(db, aboutRobin.id, robin.id, SUBJECT_OF);
    await upsertEntityEdge(db, asTable.id, robin.id, "co_mentioned");

    const ctx = await getTopicContext(db, "stg_orders");
    expect(ctx.entities.map((e) => e.id).sort()).toEqual([asModel.id, asTable.id].sort());
    const robinHop = ctx.connected.find((c) => c.entity_name === "Robin");
    expect(robinHop).toBeDefined();
    expect(robinHop!.relationship).toBe("co_mentioned");
    expect(robinHop!.facts.map((f) => f.id)).toContain(aboutRobin.id);
  });

  it("finds a hyphenated lookup via the unique folded family", async () => {
    const asDbt = await dbMod.createEntity(db, { type: "dbt_model", name: "stg_orders" });
    const fact = await dbMod.insertFact(db, {
      content: "stg_orders is missing booked_at",
      domain: "pipeline",
      source_type: "conversation",
    });
    await dbMod.linkFactEntity(db, fact.id, asDbt.id, SUBJECT_OF);

    const lookup = await lookupNamedSubject(db, "stg-orders");
    expect(lookup.found).toBe(true);
    expect(lookup.entities.map((e) => e.id)).toEqual([asDbt.id]);
    expect(lookup.facts.map((f) => f.id)).toEqual([fact.id]);
  });

  it("does not union two punctuation variants that both already exist", async () => {
    const bang = await dbMod.createEntity(db, { type: "ticket", name: "mr !412" });
    const space = await dbMod.createEntity(db, { type: "ticket", name: "mr 412" });
    const aboutBang = await dbMod.insertFact(db, {
      content: "The bang ticket is blocked on review",
      domain: "work",
      source_type: "conversation",
    });
    await dbMod.linkFactEntity(db, aboutBang.id, bang.id, SUBJECT_OF);

    const exact = await lookupNamedSubject(db, "mr !412");
    expect(exact.found).toBe(true);
    expect(exact.entities.map((e) => e.id)).toEqual([bang.id]);

    const folded = await lookupNamedSubject(db, "mr-412");
    expect(folded.found).toBe(false);
    expect(folded.entities).toEqual([]);
    expect(space.id).toBeTruthy();
  });

  it("unions two Alexes of different types without dropping either", async () => {
    const person = await dbMod.createEntity(db, { type: "person", name: "Alex" });
    const project = await dbMod.createEntity(db, { type: "project", name: "Alex" });
    const aboutPerson = await dbMod.insertFact(db, {
      content: "Alex prefers dark roast",
      domain: "profile",
      source_type: "conversation",
    });
    const aboutProject = await dbMod.insertFact(db, {
      content: "Alex is the payments cutover",
      domain: "work",
      source_type: "conversation",
    });
    await dbMod.linkFactEntity(db, aboutPerson.id, person.id, SUBJECT_OF);
    await dbMod.linkFactEntity(db, aboutProject.id, project.id, SUBJECT_OF);

    const lookup = await lookupNamedSubject(db, "Alex");
    expect(lookup.entities.map((e) => e.id).sort()).toEqual([person.id, project.id].sort());
    expect(lookup.facts.map((f) => f.id).sort()).toEqual(
      [aboutPerson.id, aboutProject.id].sort(),
    );
  });

  it("returns empty when nothing is known", async () => {
    const lookup = await lookupNamedSubject(db, "Nobody");
    expect(lookup.found).toBe(false);
    expect(lookup.facts).toEqual([]);
    expect(lookup.relationships).toEqual([]);
  });
});
