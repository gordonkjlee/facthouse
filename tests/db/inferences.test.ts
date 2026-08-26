import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDatabase, openDatabase, type Db } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { insertFact, getFact } from "../../src/db/facts.js";
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

function supportingFact(db: Db, content: string): string {
  return insertFact(db, {
    content,
    domain: "preferences",
    source_type: "conversation",
  }).id;
}

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe("insertInference", () => {
  it("stores a pending hypothesis and does not insert a fact", () => {
    const a = supportingFact(db, "The demo store prefers dark mode.");
    const b = supportingFact(db, "The demo store avoids light themes.");
    const inf = insertInference(db, {
      hypothesis: "The demo store's UI is dark-theme only.",
      evidence_fact_ids: [a, b],
    });
    expect(inf.status).toBe("pending");
    expect(inf.fact_id).toBeNull();
    expect(inf.evidence_fact_ids).toEqual([a, b].sort());
    expect(getInference(db, inf.id)!.evidence_fact_ids).toEqual(inf.evidence_fact_ids);
    expect(getFact(db, inf.id)).toBeNull();
    const facts = db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number };
    expect(facts.n).toBe(2);
  });

  it("rejects an empty hypothesis and missing evidence", () => {
    const a = supportingFact(db, "The demo store prefers dark mode.");
    expect(() =>
      insertInference(db, { hypothesis: "   ", evidence_fact_ids: [a] }),
    ).toThrow(/empty/i);
    expect(() =>
      insertInference(db, {
        hypothesis: "The demo store's UI is dark-theme only.",
        evidence_fact_ids: [],
      }),
    ).toThrow(/at least one/i);
    expect(() =>
      insertInference(db, {
        hypothesis: "The demo store's UI is dark-theme only.",
        evidence_fact_ids: ["not-a-fact"],
      }),
    ).toThrow(/Unknown evidence/);
  });
});

describe("validateInference", () => {
  it("confirm graduates a labelled fact with provenance", () => {
    const a = supportingFact(db, "The demo store prefers dark mode.");
    const inf = insertInference(db, {
      hypothesis: "The demo store's UI is dark-theme only.",
      evidence_fact_ids: [a],
    });
    const result = validateInference(db, {
      id: inf.id,
      confirmed: true,
      reason: "Robin confirmed.",
    });
    expect(result.inference.status).toBe("confirmed");
    expect(result.fact).not.toBeNull();
    expect(result.fact!.source_type).toBe("inference");
    expect(result.fact!.content).toContain("dark-theme only");
    expect(result.fact!.valid_from).toBeNull();

    const source = getSource(db, result.fact!.source_id!);
    expect(source!.type).toBe("inference");
    expect(source!.metadata).toMatchObject({
      inference_id: inf.id,
      evidence_fact_ids: [a],
    });

    const stored = getInference(db, inf.id)!;
    expect(stored.fact_id).toBe(result.fact!.id);
    expect(stored.reason).toBe("Robin confirmed.");
  });

  it("reject writes no fact", () => {
    const a = supportingFact(db, "The demo store prefers dark mode.");
    const inf = insertInference(db, {
      hypothesis: "The demo store's UI is dark-theme only.",
      evidence_fact_ids: [a],
    });
    const result = validateInference(db, {
      id: inf.id,
      confirmed: false,
      reason: "Robin said that is not true.",
    });
    expect(result.fact).toBeNull();
    expect(result.inference.status).toBe("rejected");
    const facts = db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number };
    expect(facts.n).toBe(1);
  });

  it("a second validate throws", () => {
    const a = supportingFact(db, "The demo store prefers dark mode.");
    const inf = insertInference(db, {
      hypothesis: "The demo store's UI is dark-theme only.",
      evidence_fact_ids: [a],
    });
    validateInference(db, { id: inf.id, confirmed: true });
    expect(() =>
      validateInference(db, { id: inf.id, confirmed: false }),
    ).toThrow(/already confirmed/);
  });
});

describe("listInferences", () => {
  it("defaults to pending and excludes confirmed", () => {
    const a = supportingFact(db, "The demo store prefers dark mode.");
    const pending = insertInference(db, {
      hypothesis: "Still pending.",
      evidence_fact_ids: [a],
    });
    const done = insertInference(db, {
      hypothesis: "Will confirm.",
      evidence_fact_ids: [a],
    });
    validateInference(db, { id: done.id, confirmed: true });
    const listed = listInferences(db);
    expect(listed.map((i) => i.id)).toEqual([pending.id]);
    expect(listInferences(db, "confirmed")).toHaveLength(1);
  });
});

describe("consolidate does not invent inferences", () => {
  it("graduating a session fact leaves the inferences table empty", async () => {
    const session = createSession(db, { source_tool: "claude-code", project: null });
    insertSessionFact(db, {
      session_id: session.id,
      content: "The demo store prefers dark mode.",
      source_origin: "explicit",
      source_quality: "explicit",
    });
    await consolidate(db, createHeuristicProvider());
    const n = db.prepare(`SELECT COUNT(*) AS n FROM inferences`).get() as { n: number };
    expect(n.n).toBe(0);
    const inferred = db
      .prepare(`SELECT COUNT(*) AS n FROM facts WHERE source_type = 'inference'`)
      .get() as { n: number };
    expect(inferred.n).toBe(0);
  });
});
