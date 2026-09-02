import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession, insertEvent } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

let db: Db;
let sessionId: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
  sessionId = (await createSession(db, { source_tool: "test", project: "om" })).id;
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("consolidation watermark", () => {
  it("records last_event_sequence when no facts are extracted", async () => {
    // Seed a handful of events the heuristic can't extract facts from.
    for (let i = 0; i < 5; i++) {
      await insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "message",
        role: "user",
        content: `just some filler text ${i}`,
      });
    }

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {
      extraction: { enabled: true } as any,
    });

    // Empty run — no facts integrated, but a consolidations row still exists.
    expect(result.factsIntegrated).toBe(0);

    const row = (await db
      .prepare(
        `SELECT last_event_sequence FROM consolidations ORDER BY created_at DESC LIMIT 1`,
      )
      .get()) as { last_event_sequence: number };

    expect(row.last_event_sequence).toBe(5);
  });

  it("suppresses redundant empty rows when watermark is unchanged", async () => {
    // First run with one event → writes a row at watermark 1.
    await insertEvent(db, {
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

    const rows = (await db
      .prepare(`SELECT COUNT(*) AS n FROM consolidations`)
      .get()) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("advances watermark across successive runs", async () => {
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "event one",
    });
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), { extraction: { enabled: true } as any });

    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "event two",
    });
    await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "event three",
    });
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), { extraction: { enabled: true } as any });

    const rows = (await db
      .prepare(`SELECT last_event_sequence FROM consolidations ORDER BY created_at ASC`)
      .all()) as Array<{ last_event_sequence: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].last_event_sequence).toBe(1);
    expect(rows[1].last_event_sequence).toBe(3);
  });
});

describe("the watermark holds when extraction could not run", () => {
  /**
   * The watermark advances on an empty run deliberately, so a batch that will
   * never yield anything cannot stall consolidation for ever. That is right for
   * "nothing here was worth keeping" and wrong for "the extractor never ran":
   * the second discards a batch of conversation permanently, because the events
   * stay in the database while nothing ever looks at them again.
   *
   * Found in practice, not in theory — a `claude -p` subprocess failed during an
   * evaluation run, four events were skipped, and the result object reported a
   * clean consolidation.
   */
  const failingProvider = (fallback: any) => ({
    ...fallback,
    async extractFactsFromEvents() {
      // What a provider returns when its model call failed and it fell back.
      return { facts: [], degraded: true };
    },
  });

  async function seed(n: number) {
    for (let i = 0; i < n; i++) {
      await insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "message",
        role: "user",
        content: `The user mentioned something worth keeping ${i}`,
      });
    }
  }

  it("does not advance past events the extractor never examined", async () => {
    await seed(4);
    const base = createHeuristicProvider(PERSONAL_VOCABULARY);

    const result = await consolidate(db, failingProvider(base) as any, {
      extraction: { enabled: true } as any,
    });

    expect(result.extractionDegraded).toBe(true);

    // The watermark is what decides whether these events are ever read again.
    const row = (await db
      .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
      .get()) as { seq: number };
    expect(row.seq).toBe(0);
  });

  it("leaves the same events eligible for the next run", async () => {
    // The consequence that matters. A held watermark is only worth anything if
    // a later, working run actually picks the events back up.
    await seed(4);
    const base = createHeuristicProvider(PERSONAL_VOCABULARY);
    await consolidate(db, failingProvider(base) as any, {
      extraction: { enabled: true } as any,
    });

    let seen = 0;
    const recovering = {
      ...base,
      async extractFactsFromEvents(events: unknown[]) {
        seen = events.length;
        return { facts: [], degraded: false };
      },
    };
    await consolidate(db, recovering as any, { extraction: { enabled: true } as any });

    expect(seen).toBe(4);
  });

  it("holds the watermark even when other facts integrate in the same run", async () => {
    // The path the two tests above do not reach. When a run integrates nothing,
    // no consolidations row is written at all, so the watermark stays put for a
    // second reason and the gate is never consulted. Explicit captures integrate
    // independently of event extraction — so a run can succeed loudly, write its
    // row, and advance past events that were never read.
    await seed(4);
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "The user prefers dark roast coffee",
      source_origin: "explicit",
    });
    const base = createHeuristicProvider(PERSONAL_VOCABULARY);

    const result = await consolidate(db, failingProvider(base) as any, {
      extraction: { enabled: true } as any,
    });

    // A row was written: this is the loud-success path.
    expect(result.factsIntegrated).toBeGreaterThan(0);
    expect(result.extractionDegraded).toBe(true);
    const rows = (await db
      .prepare(`SELECT COUNT(*) AS n FROM consolidations`)
      .get()) as { n: number };
    expect(rows.n).toBe(1);

    // ...and it must not claim the events the extractor never saw.
    const row = (await db
      .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
      .get()) as { seq: number };
    expect(row.seq).toBe(0);
  });

  it("still advances when the extractor ran and simply found nothing", async () => {
    // The distinction the flag exists for. A store deliberately using the
    // zero-dependency provider extracts nothing by design, and must not be
    // treated as failing — its watermark would never move and the backlog would
    // grow without bound.
    await seed(3);

    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {
      extraction: { enabled: true } as any,
    });

    expect(result.extractionDegraded).toBe(false);
    const row = (await db
      .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
      .get()) as { seq: number };
    expect(row.seq).toBe(3);
  });
});
