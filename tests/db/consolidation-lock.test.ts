import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { acquireLock, releaseLock, getLockState } = await import("../../src/db/consolidation-lock.js");

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

  it("is reentrant for the same holder and refreshes started_at", async () => {
    expect(await acquireLock(db, "holder-a")).toBe(true);
    const first = (await getLockState(db))!.started_at;
    await new Promise((r) => setTimeout(r, 10));
    expect(await acquireLock(db, "holder-a")).toBe(true);
    const second = (await getLockState(db))!.started_at;
    expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
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
});
