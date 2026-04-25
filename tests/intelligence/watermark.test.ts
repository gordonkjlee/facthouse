import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

let canLoadSqlite = false;
try {
  const Db = (await import("better-sqlite3")).default;
  const probe = new Db(":memory:");
  probe.close();
  canLoadSqlite = true;
} catch {}

const { openDatabase, closeDatabase } = canLoadSqlite
  ? await import("../../src/db/connection.js")
  : ({} as any);
const { applySchema } = canLoadSqlite
  ? await import("../../src/db/schema.js")
  : ({} as any);
const { createSession, insertEvent } = canLoadSqlite
  ? await import("../../src/db/sessions.js")
  : ({} as any);
const { consolidate } = canLoadSqlite
  ? await import("../../src/intelligence/consolidate.js")
  : ({} as any);
const { createHeuristicProvider } = canLoadSqlite
  ? await import("../../src/intelligence/heuristic.js")
  : ({} as any);

let db: Database.Database;
let sessionId: string;

beforeEach(() => {
  if (!canLoadSqlite) return;
  db = openDatabase(":memory:");
  applySchema(db);
  sessionId = createSession(db, { source_tool: "test", project: "om" }).id;
});

afterEach(() => {
  if (!canLoadSqlite) return;
  closeDatabase(db);
});

describe.skipIf(!canLoadSqlite)("consolidation watermark", () => {
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

    const result = await consolidate(db, createHeuristicProvider(), {
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
    await consolidate(db, createHeuristicProvider(), { extraction: { enabled: true } as any });

    // Second run with NO new events. Watermark would be same as prev → skip insert.
    await consolidate(db, createHeuristicProvider(), { extraction: { enabled: true } as any });

    // Third run with NO new events — still skipped.
    await consolidate(db, createHeuristicProvider(), { extraction: { enabled: true } as any });

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
    await consolidate(db, createHeuristicProvider(), { extraction: { enabled: true } as any });

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
    await consolidate(db, createHeuristicProvider(), { extraction: { enabled: true } as any });

    const rows = db
      .prepare(`SELECT last_event_sequence FROM consolidations ORDER BY created_at ASC`)
      .all() as Array<{ last_event_sequence: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].last_event_sequence).toBe(1);
    expect(rows[1].last_event_sequence).toBe(3);
  });
});
