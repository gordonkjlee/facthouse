import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Db } from "../../src/db/connection.js";


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const {
  acquireLock,
  releaseLock,
  refreshLock,
  getLockState,
  startLockHeartbeat,
  LOCK_HEARTBEAT_MS,
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
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("consolidation lock", () => {
  it("acquires when no holder exists", async () => {
    expect(await acquireLock(db, "holder-a")).toBe(true);
    const state = await getLockState(db);
    expect(state?.holder).toBe("holder-a");
  });

  it("refuses a second acquirer while fresh", async () => {
    expect(await acquireLock(db, "holder-a")).toBe(true);
    expect(await acquireLock(db, "holder-b")).toBe(false);
  });

  it("is reentrant for the same holder and refreshes the lease without moving started_at", async () => {
    expect(await acquireLock(db, "holder-a")).toBe(true);
    const first = (await getLockState(db))!;
    await new Promise((r) => setTimeout(r, 10));
    expect(await acquireLock(db, "holder-a")).toBe(true);
    const second = (await getLockState(db))!;
    expect(second.started_at).toBe(first.started_at);
    expect(Date.parse(second.heartbeat_at!)).toBeGreaterThanOrEqual(
      Date.parse(first.heartbeat_at!),
    );
  });

  it("releases cleanly for the holder", async () => {
    expect(await acquireLock(db, "holder-a")).toBe(true);
    expect(await releaseLock(db, "holder-a")).toBe(true);
    expect(await getLockState(db)).toBeNull();
  });

  it("refuses release for a non-holder", async () => {
    expect(await acquireLock(db, "holder-a")).toBe(true);
    expect(await releaseLock(db, "holder-b")).toBe(false);
    // Original holder still has it
    expect((await getLockState(db))?.holder).toBe("holder-a");
  });

  it("reclaims a stale lock older than the 2-minute threshold", async () => {
    // Simulate a crashed prior consolidation by inserting a lock row manually
    // with a started_at in the past. STALE_LOCK_MS = 2 * 60 * 1000 per
    // src/db/consolidation-lock.ts — so 3 minutes is safely stale.
    const staleTime = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at) VALUES (1, ?, ?)`,
    ).run("crashed-holder", staleTime);

    // New acquirer should take over.
    expect(await acquireLock(db, "new-holder")).toBe(true);
    const state = await getLockState(db);
    expect(state?.holder).toBe("new-holder");
    expect(new Date(state!.started_at).getTime()).toBeGreaterThan(
      new Date(staleTime).getTime(),
    );
  });

  it("does NOT reclaim a lock within the 2-minute window", async () => {
    // 30s ago — well within the 2-minute freshness window.
    const freshTime = new Date(Date.now() - 30 * 1000).toISOString();
    await db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at) VALUES (1, ?, ?)`,
    ).run("current-holder", freshTime);

    expect(await acquireLock(db, "interloper")).toBe(false);
    expect((await getLockState(db))?.holder).toBe("current-holder");
  });

  it("keeps the stale window at least four heartbeats", () => {
    expect(STALE_LOCK_MS).toBeGreaterThanOrEqual(4 * LOCK_HEARTBEAT_MS);
    expect(LOCK_HEARTBEAT_MS).toBe(30_000);
  });

  it("does not steal a fresh heartbeat even when the run started long ago", async () => {
    const started = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const heartbeat = new Date(Date.now() - 30 * 1000).toISOString();
    await db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at, heartbeat_at)
       VALUES (1, ?, ?, ?)`,
    ).run("live", started, heartbeat);

    expect(await acquireLock(db, "other")).toBe(false);
    const state = await getLockState(db);
    expect(state?.holder).toBe("live");
    expect(state?.started_at).toBe(started);
  });

  it("steals when the heartbeat is older than the stale window", async () => {
    const started = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const heartbeat = new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString();
    await db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at, heartbeat_at)
       VALUES (1, ?, ?, ?)`,
    ).run("dead", started, heartbeat);

    expect(await acquireLock(db, "new")).toBe(true);
    const state = await getLockState(db);
    expect(state?.holder).toBe("new");
    expect(Date.parse(state!.started_at)).toBeGreaterThan(Date.parse(started));
  });

  it("does not steal a holder that keeps heartbeating past the stale window", async () => {
    vi.useFakeTimers();
    try {
      expect(await acquireLock(db, "live")).toBe(true);
      const beat = startLockHeartbeat(db, "live");
      const first = (await getLockState(db))!.heartbeat_at!;
      await vi.advanceTimersByTimeAsync(STALE_LOCK_MS + LOCK_HEARTBEAT_MS);
      const second = (await getLockState(db))!.heartbeat_at!;
      expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
      expect(await acquireLock(db, "other")).toBe(false);
      expect((await getLockState(db))?.holder).toBe("live");
      beat.stop();
      await releaseLock(db, "live");
    } finally {
      vi.useRealTimers();
    }
  });

  it("steals a holder whose heartbeat stopped, and the old refresh reports lost", async () => {
    vi.useFakeTimers();
    try {
      expect(await acquireLock(db, "old")).toBe(true);
      const beat = startLockHeartbeat(db, "old");
      beat.stop();
      await vi.advanceTimersByTimeAsync(STALE_LOCK_MS + 1);
      expect(await acquireLock(db, "new")).toBe(true);
      expect(await refreshLock(db, "old")).toBe(false);
      expect(await refreshLock(db, "new")).toBe(true);
      expect((await getLockState(db))?.holder).toBe("new");
      await releaseLock(db, "new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports lost when the row is taken between refreshes", async () => {
    expect(await acquireLock(db, "old")).toBe(true);
    await db.prepare(
      `UPDATE consolidation_lock SET holder = ? WHERE id = 1`,
    ).run("thief");
    expect(await refreshLock(db, "old")).toBe(false);
    expect(await refreshLock(db, "thief")).toBe(true);
    await releaseLock(db, "thief");
  });

  it("runs the heartbeat on an unref'd timer and stops it on release", async () => {
    const tracked = trackIntervals();
    try {
      expect(await acquireLock(db, "holder-a")).toBe(true);
      const beat = startLockHeartbeat(db, "holder-a");
      expect(tracked.timers).toHaveLength(1);
      expect(tracked.timers[0]!.hasRef()).toBe(false);
      expect(beat.lost()).toBe(false);
      await releaseLock(db, "holder-a");
      expect(tracked.timers[0]!._destroyed).toBe(true);
      expect(await getLockState(db)).toBeNull();
    } finally {
      tracked.restore();
    }
  });
});
