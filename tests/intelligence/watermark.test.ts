import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession, insertEvent } = await import("../../src/db/sessions.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

let db: Db;
let sessionId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
  sessionId = createSession(db, { source_tool: "test", project: "om" }).id;
});

afterEach(() => {
  closeDatabase(db);
});

describe("consolidation watermark", () => {
  it("records last_event_sequence when no facts are extracted", async () => {
    // Seed a handful of events the heuristic can't extract facts from.
    for (let i = 0; i < 5; i++) {
      insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "message",
        role: "user",
        content: `just some filler text ${i}`,
      });
    }

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {
      extraction: { enabled: true } as any,
    });

    // Empty run — no facts graduated, but a consolidations row still exists.
    expect(result.factsGraduated).toBe(0);

    const row = db
      .prepare(
        `SELECT last_event_sequence FROM consolidations ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { last_event_sequence: number };

    expect(row.last_event_sequence).toBe(5);
  });

  it("suppresses redundant empty rows when watermark is unchanged", async () => {
    // First run with one event → writes a row at watermark 1.
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "trigger event",
    });
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), { extraction: { enabled: true } as any });

    // Second run with NO new events. Watermark would be same as prev → skip insert.
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), { extraction: { enabled: true } as any });

    // Third run with NO new events — still skipped.
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), { extraction: { enabled: true } as any });

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM consolidations`)
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("advances watermark across successive runs", async () => {
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "event one",
    });
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), { extraction: { enabled: true } as any });

    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "event two",
    });
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "event three",
    });
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), { extraction: { enabled: true } as any });

    const rows = db
      .prepare(`SELECT last_event_sequence FROM consolidations ORDER BY created_at ASC`)
      .all() as Array<{ last_event_sequence: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].last_event_sequence).toBe(1);
    expect(rows[1].last_event_sequence).toBe(3);
  });
});
