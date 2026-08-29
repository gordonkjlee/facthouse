import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDatabase, openDatabase, type Db } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { insertFact, getFact } from "../../src/db/facts.js";
import { createEntity, resolveEntityFamily } from "../../src/db/entities.js";
import { getSource } from "../../src/db/sources.js";
import {
  insertInference,
  getInference,
  listInferences,
  validateInference,
} from "../../src/db/inferences.js";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
import { consolidate } from "../../src/intelligence/consolidate.js";
import { insertSessionFact } from "../../src/db/session-facts.js";
import { createSession } from "../../src/db/sessions.js";

async function supportingFact(db: Db, content: string): Promise<string> {
  return (await insertFact(db, {
    content,
    domain: "preferences",
    source_type: "conversation",
  })).id;
}

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("insertInference", () => {
  it("stores a pending hypothesis and does not insert a fact", async () => {
    const a = await supportingFact(db, "The demo store prefers dark mode.");
    const b = await supportingFact(db, "The demo store avoids light themes.");
    const inf = await insertInference(db, {
      hypothesis: "The demo store's UI is dark-theme only.",
      evidence_fact_ids: [a, b],
    });
    expect(inf.status).toBe("pending");
    expect(inf.fact_id).toBeNull();
    expect(inf.evidence_fact_ids).toEqual([a, b].sort());
    expect((await getInference(db, inf.id))!.evidence_fact_ids).toEqual(inf.evidence_fact_ids);
    expect(await getFact(db, inf.id)).toBeNull();
    const facts = (await db.prepare(`SELECT COUNT(*) AS n FROM facts`).get()) as { n: number };
    expect(facts.n).toBe(2);
  });

  it("rejects an empty hypothesis and missing evidence", async () => {
    const a = await supportingFact(db, "The demo store prefers dark mode.");
    await expect(
      insertInference(db, { hypothesis: "   ", evidence_fact_ids: [a] }),
    ).rejects.toThrow(/empty/i);
    await expect(
      insertInference(db, {
        hypothesis: "The demo store's UI is dark-theme only.",
        evidence_fact_ids: [],
      }),
    ).rejects.toThrow(/at least one/i);
    await expect(
      insertInference(db, {
        hypothesis: "The demo store's UI is dark-theme only.",
        evidence_fact_ids: ["not-a-fact"],
      }),
    ).rejects.toThrow(/Unknown evidence/);
  });
});

describe("validateInference", () => {
  it("confirm graduates a labelled fact with provenance", async () => {
    const a = await supportingFact(db, "The demo store prefers dark mode.");
    const inf = await insertInference(db, {
      hypothesis: "The demo store's UI is dark-theme only.",
      evidence_fact_ids: [a],
    });
    const result = await validateInference(db, {
      id: inf.id,
      confirmed: true,
      reason: "Robin confirmed.",
    });
    expect(result.inference.status).toBe("confirmed");
    expect(result.fact).not.toBeNull();
    expect(result.fact!.source_type).toBe("inference");
    expect(result.fact!.content).toContain("dark-theme only");
    expect(result.fact!.valid_from).toBeNull();

    const source = await getSource(db, result.fact!.source_id!);
    expect(source!.type).toBe("inference");
    expect(source!.metadata).toMatchObject({
      inference_id: inf.id,
      evidence_fact_ids: [a],
    });

    const stored = (await getInference(db, inf.id))!;
    expect(stored.fact_id).toBe(result.fact!.id);
    expect(stored.reason).toBe("Robin confirmed.");
  });

  it("reject writes no fact", async () => {
    const a = await supportingFact(db, "The demo store prefers dark mode.");
    const inf = await insertInference(db, {
      hypothesis: "The demo store's UI is dark-theme only.",
      evidence_fact_ids: [a],
    });
    const result = await validateInference(db, {
      id: inf.id,
      confirmed: false,
      reason: "Robin said that is not true.",
    });
    expect(result.fact).toBeNull();
    expect(result.inference.status).toBe("rejected");
    const facts = (await db.prepare(`SELECT COUNT(*) AS n FROM facts`).get()) as { n: number };
    expect(facts.n).toBe(1);
  });

  it("a second validate throws", async () => {
    const a = await supportingFact(db, "The demo store prefers dark mode.");
    const inf = await insertInference(db, {
      hypothesis: "The demo store's UI is dark-theme only.",
      evidence_fact_ids: [a],
    });
    await validateInference(db, { id: inf.id, confirmed: true });
    await expect(
      validateInference(db, { id: inf.id, confirmed: false }),
    ).rejects.toThrow(/already confirmed/);
  });
});

describe("listInferences", () => {
  it("defaults to pending and excludes confirmed", async () => {
    const a = await supportingFact(db, "The demo store prefers dark mode.");
    const pending = await insertInference(db, {
      hypothesis: "Still pending.",
      evidence_fact_ids: [a],
    });
    const done = await insertInference(db, {
      hypothesis: "Will confirm.",
      evidence_fact_ids: [a],
    });
    await validateInference(db, { id: done.id, confirmed: true });
    const listed = await listInferences(db);
    expect(listed.map((i) => i.id)).toEqual([pending.id]);
    expect(await listInferences(db, "confirmed")).toHaveLength(1);
  });
});

describe("same_as via inference confirm", () => {
  it("pending does not join; confirm does; reject does not", async () => {
    const factA = await supportingFact(db, "The bang ticket is blocked on review.");
    const bang = await createEntity(db, { type: "ticket", name: "mr !412" });
    const space = await createEntity(db, { type: "ticket", name: "mr 412" });

    const pending = await insertInference(db, {
      hypothesis: "Those two names are one ticket.",
      evidence_fact_ids: [factA],
      entity_ids: [bang.id, space.id],
    });
    expect(pending.entity_ids.sort()).toEqual([bang.id, space.id].sort());
    expect(await resolveEntityFamily(db, "mr 412")).toHaveLength(1);

    const rejected = await insertInference(db, {
      hypothesis: "A guess we will reject.",
      evidence_fact_ids: [factA],
      entity_ids: [bang.id, space.id],
    });
    await validateInference(db, { id: rejected.id, confirmed: false });
    expect(await resolveEntityFamily(db, "mr 412")).toHaveLength(1);

    await validateInference(db, { id: pending.id, confirmed: true });
    expect((await resolveEntityFamily(db, "mr 412")).map((e) => e.id).sort()).toEqual(
      [bang.id, space.id].sort(),
    );
  });

  it("two paraphrases on two nodes write no edge by themselves", async () => {
    await createEntity(db, { type: "ticket", name: "mr !412" });
    await createEntity(db, { type: "ticket", name: "mr 412" });
    await supportingFact(db, "The bang ticket is blocked on review.");
    await supportingFact(db, "The space ticket is blocked on review.");
    expect(await resolveEntityFamily(db, "mr 412")).toHaveLength(1);
  });
});

describe("consolidate does not invent inferences", () => {
  it("graduating a session fact leaves the inferences table empty", async () => {
    const session = await createSession(db, { source_tool: "claude-code", project: null });
    await insertSessionFact(db, {
      session_id: session.id,
      content: "The demo store prefers dark mode.",
      source_origin: "explicit",
      source_quality: "explicit",
    });
    await consolidate(db, createHeuristicProvider());
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM inferences`).get()) as { n: number };
    expect(n.n).toBe(0);
    const inferred = (await db
      .prepare(`SELECT COUNT(*) AS n FROM facts WHERE source_type = 'inference'`)
      .get()) as { n: number };
    expect(inferred.n).toBe(0);
  });
});
