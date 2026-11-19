/**
 * The consolidation lease stays with a live run, and a run that loses it
 * stops without further writes.
 *
 * Synthetic fixtures only — Alex / Acme.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Db } from "../../src/db/connection.js";
import type { SessionEvent } from "../../src/types/data.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";
import { ConsolidateAbortError } from "../../src/intelligence/abort.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { createSession } = await import("../../src/db/sessions.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
const { conversationExtractThrough } = await import("../../src/db/extract-watermarks.js");
const {
  getLockState,
  LOCK_HEARTBEAT_MS,
  LOCK_LOST_REASON,
  STALE_LOCK_MS,
} = await import("../../src/db/consolidation-lock.js");

type TrackedTimer = ReturnType<typeof setInterval> & { _destroyed?: boolean };

function trackIntervals(): { timers: TrackedTimer[]; restore: () => void } {
  const timers: TrackedTimer[] = [];
  const orig = globalThis.setInterval;
  const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
    fn: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => {
    const timer = orig(fn as never, ms as number, ...(args as [])) as TrackedTimer;
    timers.push(timer);
    return timer;
  }) as typeof setInterval);
  return {
    timers,
    restore() {
      spy.mockRestore();
    },
  };
}

let db: Db;

beforeEach(async () => {
  vi.useRealTimers();
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDatabase(db);
});

const steps = { copy: false, extract: true, integrate: true } as const;

describe("consolidation lock heartbeat", () => {
  it("stops the heartbeat when the run finishes", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertSessionFact(db, { session_id: session.id, content: "My name is Alex" });
    const tracked = trackIntervals();
    const base = createHeuristicProvider(PERSONAL_VOCABULARY);
    let during = 0;
    const provider = {
      ...base,
      classifyFacts: async (
        facts: Parameters<typeof base.classifyFacts>[0],
      ) => {
        during = tracked.timers.length;
        expect(tracked.timers.every((h) => h.hasRef() === false)).toBe(true);
        expect(tracked.timers.every((h) => h._destroyed !== true)).toBe(true);
        return base.classifyFacts(facts);
      },
    };

    try {
      const result = await consolidate(db, provider);
      expect(result.skipped).toBe(false);
      expect(result.factsIntegrated).toBe(1);
      expect(during).toBe(1);
      expect(tracked.timers.every((h) => h._destroyed === true)).toBe(true);
      expect(await getLockState(db)).toBeNull();
    } finally {
      tracked.restore();
    }
  });

  it("stops the heartbeat when the run throws", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertSessionFact(db, { session_id: session.id, content: "will be unclaimed" });
    const tracked = trackIntervals();
    const provider = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      classifyFacts: async () => {
        throw new Error("simulated provider failure");
      },
    };

    try {
      await expect(consolidate(db, provider)).rejects.toThrow("simulated provider failure");
      expect(tracked.timers.length).toBeGreaterThan(0);
      expect(tracked.timers.every((h) => h._destroyed === true)).toBe(true);
      expect(await getLockState(db)).toBeNull();
    } finally {
      tracked.restore();
    }
  });

  it("stops the heartbeat when the run is aborted", async () => {
    await insertEvent(db, {
      client_session_id: "sess-one",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    const abort = new AbortController();
    const tracked = trackIntervals();
    const provider = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents() {
        abort.abort();
        return { facts: [], degraded: false, aborted: true };
      },
    };

    try {
      await expect(
        consolidate(
          db,
          provider as never,
          { extraction: { enabled: true } } as never,
          null,
          steps,
          { abort: abort.signal, extractLimit: null },
        ),
      ).rejects.toBeInstanceOf(ConsolidateAbortError);
      expect(tracked.timers.length).toBeGreaterThan(0);
      expect(tracked.timers.every((h) => h.hasRef() === false)).toBe(true);
      expect(tracked.timers.every((h) => h._destroyed === true)).toBe(true);
      expect(await getLockState(db)).toBeNull();
    } finally {
      tracked.restore();
    }
  });

  it("stops without further writes when the lease is lost between extract batches", async () => {
    await insertEvent(db, {
      client_session_id: "sess-one",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
      client_session_id: "sess-two",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });
    const tracked = trackIntervals();
    let calls = 0;
    let integrated = 0;
    const provider = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents(events: SessionEvent[]) {
        calls += 1;
        if (calls === 2) {
          await db.prepare(
            `UPDATE consolidation_lock SET holder = ? WHERE id = 1`,
          ).run("thief");
        }
        return {
          facts: events
            .filter((e) => e.content)
            .map((e) => ({
              content: e.content as string,
              domain_hint: "preferences",
            })),
          degraded: false,
        };
      },
      async classifyFacts() {
        integrated += 1;
        return [];
      },
    };

    let result;
    try {
      result = await consolidate(
        db,
        provider as never,
        { extraction: { enabled: true } } as never,
        null,
        steps,
        { extractLimit: null },
      );
    } finally {
      tracked.restore();
    }

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe(LOCK_LOST_REASON);
    expect(result.factsIntegrated).toBe(0);
    expect(calls).toBe(2);
    expect(integrated).toBe(0);
    expect(
      await conversationExtractThrough(db, { kind: "client", id: "sess-one" }),
    ).toBeGreaterThan(0);
    expect(
      await conversationExtractThrough(db, { kind: "client", id: "sess-two" }),
    ).toBe(0);
    const staged = (await db
      .prepare(`SELECT content, consolidation_id FROM session_facts`)
      .all()) as Array<{ content: string; consolidation_id: string | null }>;
    expect(staged).toHaveLength(1);
    expect(staged[0]!.content).toContain("oat milk");
    expect(staged[0]!.consolidation_id).toBeNull();
    const knowledge = (await db.prepare(`SELECT COUNT(*) AS n FROM facts`).get()) as {
      n: number;
    };
    expect(knowledge.n).toBe(0);
    expect((await getLockState(db))?.holder).toBe("thief");
    expect(tracked.timers.length).toBeGreaterThan(0);
    expect(tracked.timers.every((h) => h._destroyed === true)).toBe(true);
  });

  it("keeps the lease through a model call longer than the stale window", async () => {
    vi.useFakeTimers();
    try {
      await insertEvent(db, {
        client_session_id: "sess-one",
        event_type: "message",
        role: "user",
        content: "Alex prefers oat milk at Acme.",
      });
      const base = createHeuristicProvider(PERSONAL_VOCABULARY);
      const provider = {
        ...base,
        async extractFactsFromEvents(
          ...args: Parameters<typeof base.extractFactsFromEvents>
        ) {
          const beforeBeat = await getLockState(db);
          await vi.advanceTimersByTimeAsync(STALE_LOCK_MS + LOCK_HEARTBEAT_MS);
          const afterBeat = await getLockState(db);
          expect(afterBeat?.holder).toBe(beforeBeat?.holder);
          expect(Date.parse(afterBeat!.heartbeat_at!)).toBeGreaterThan(
            Date.parse(beforeBeat!.heartbeat_at!),
          );
          return base.extractFactsFromEvents(...args);
        },
      };

      const result = await consolidate(
        db,
        provider,
        { extraction: { enabled: true } } as never,
        null,
        steps,
        { extractLimit: null },
      );
      expect(result.skipped).toBe(false);
      expect(await getLockState(db)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
