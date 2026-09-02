/**
 * consolidate() runs the steps it is given and no others; extract is capped
 * per run and reports what it left behind.
 *
 * Synthetic fixtures only — Alex / Acme.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import type { SessionEvent } from "../../src/types/data.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent, createSession } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
const { EXTRACT_CAP_EVENTS } = await import("../../src/intelligence/steps.js");
const { extractWatermark, unexaminedEventCount } = await import(
  "../../src/db/extract-watermarks.js"
);

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

/** A provider that counts the events each extract call examined. */
function counting() {
  const examined: string[] = [];
  let extractCalls = 0;
  const provider = {
    ...createHeuristicProvider(PERSONAL_VOCABULARY),
    async extractFactsFromEvents(events: SessionEvent[]) {
      extractCalls++;
      for (const e of events) examined.push(e.content ?? "");
      return { facts: [], degraded: false };
    },
  };
  return { provider, examined, calls: () => extractCalls };
}

async function seedConversation(n: number, session = "sess-aaa"): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertEvent(db, {
      client_session_id: session,
      event_type: "message",
      role: "user",
      content: `line ${i + 1} about oat milk at Acme`,
    });
  }
}

const EXTRACT_ONLY = { copy: false, extract: true, integrate: false };
const CONFIG = { extraction: { enabled: true, batch_size: 100 } as never };

describe("the copy step", () => {
  it("runs the caller's copier when copy is on and reports what landed", async () => {
    const { provider } = counting();
    let called = 0;
    const result = await consolidate(
      db,
      provider as never,
      CONFIG,
      null,
      { copy: true, extract: false, integrate: false },
      {
        copy: async () => {
          called++;
          return { events_inserted: 7 };
        },
      },
    );
    expect(called).toBe(1);
    expect(result.eventsCopied).toBe(7);
    expect(result.factsIntegrated).toBe(0);
  });

  it("does not call the copier when copy is off", async () => {
    const { provider } = counting();
    let called = 0;
    const result = await consolidate(db, provider as never, CONFIG, null, EXTRACT_ONLY, {
      copy: async () => {
        called++;
        return { events_inserted: 7 };
      },
    });
    expect(called).toBe(0);
    expect(result.eventsCopied).toBe(0);
  });

  it("is a no-op when the caller supplies no copier", async () => {
    const { provider } = counting();
    const result = await consolidate(db, provider as never, CONFIG, null, {
      copy: true,
      extract: false,
      integrate: false,
    });
    expect(result.eventsCopied).toBe(0);
  });
});

describe("the extract cap", () => {
  it("examines at most the cap by default and reports the remainder", async () => {
    await seedConversation(EXTRACT_CAP_EVENTS + 10);
    const { provider, examined } = counting();
    expect(await unexaminedEventCount(db)).toBe(EXTRACT_CAP_EVENTS + 10);

    const result = await consolidate(db, provider as never, CONFIG, null, EXTRACT_ONLY);

    expect(examined).toHaveLength(EXTRACT_CAP_EVENTS);
    expect(examined[0]).toBe("line 1 about oat milk at Acme");
    expect(result.eventsRemaining).toBe(10);
    expect(await unexaminedEventCount(db)).toBe(10);
    // The watermark moved only through what was examined.
    expect(await extractWatermark(db)).toBe(EXTRACT_CAP_EVENTS);
  });

  it("a second run takes the next batch, so a backlog always drains", async () => {
    await seedConversation(EXTRACT_CAP_EVENTS + 10);
    const { provider, examined } = counting();
    await consolidate(db, provider as never, CONFIG, null, EXTRACT_ONLY);
    const second = await consolidate(db, provider as never, CONFIG, null, EXTRACT_ONLY);
    expect(examined).toHaveLength(EXTRACT_CAP_EVENTS + 10);
    expect(second.eventsRemaining).toBe(0);
  });

  it("extractLimit null lifts the cap", async () => {
    await seedConversation(EXTRACT_CAP_EVENTS + 10);
    const { provider, examined } = counting();
    const result = await consolidate(db, provider as never, CONFIG, null, EXTRACT_ONLY, {
      extractLimit: null,
    });
    expect(examined).toHaveLength(EXTRACT_CAP_EVENTS + 10);
    expect(result.eventsRemaining).toBe(0);
  });

  it("extractLimit N takes the oldest N across conversations, oldest first", async () => {
    await seedConversation(3, "sess-old");
    await seedConversation(3, "sess-new");
    const { provider, examined, calls } = counting();
    const result = await consolidate(db, provider as never, CONFIG, null, EXTRACT_ONLY, {
      extractLimit: 4,
    });
    // Three from the older conversation, one from the newer.
    expect(examined).toHaveLength(4);
    expect(calls()).toBe(2);
    expect(result.eventsRemaining).toBe(2);
    expect(await unexaminedEventCount(db)).toBe(2);
  });

  it("a truncated conversation is not marked examined past its last line", async () => {
    await seedConversation(5);
    const { provider } = counting();
    await consolidate(db, provider as never, CONFIG, null, EXTRACT_ONLY, {
      extractLimit: 2,
    });
    expect(await extractWatermark(db)).toBe(2);
    expect(await unexaminedEventCount(db)).toBe(3);
  });

  it("integrate-only never touches the cap or the copier", async () => {
    await seedConversation(EXTRACT_CAP_EVENTS + 10);
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertSessionFact(db, {
      session_id: session.id,
      content: "The user prefers oat milk in coffee",
    });
    const { provider, examined } = counting();
    let copied = 0;
    const result = await consolidate(
      db,
      provider as never,
      CONFIG,
      null,
      { copy: false, extract: false, integrate: true },
      {
        copy: async () => {
          copied++;
          return { events_inserted: 1 };
        },
      },
    );
    expect(copied).toBe(0);
    expect(examined).toHaveLength(0);
    expect(result.factsIntegrated).toBe(1);
    expect(result.eventsRemaining).toBe(EXTRACT_CAP_EVENTS + 10);
    expect(await extractWatermark(db)).toBe(0);
  });
});
