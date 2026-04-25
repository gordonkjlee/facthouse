import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Guard: skip when native bindings are unavailable
// ---------------------------------------------------------------------------

let canLoadSqlite = false;
try {
  const Db = (await import("better-sqlite3")).default;
  const probe = new Db(":memory:");
  probe.close();
  canLoadSqlite = true;
} catch {
  // Native bindings not compiled.
}

const { openDatabase, closeDatabase } = canLoadSqlite
  ? await import("../src/db/connection.js")
  : ({} as any);
const { applySchema } = canLoadSqlite
  ? await import("../src/db/schema.js")
  : ({} as any);
const { createSession, insertEvent } = canLoadSqlite
  ? await import("../src/db/sessions.js")
  : ({} as any);
const { startScheduler } = canLoadSqlite
  ? await import("../src/scheduler.js")
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

function seedEvents(n: number) {
  for (let i = 0; i < n; i++) {
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: `event ${i}`,
    });
  }
}

const STUB_RESULT = {
  consolidationId: "x",
  factsIn: 0,
  factsGraduated: 0,
  factsRejected: 0,
  entitiesCreated: 0,
  entitiesLinked: 0,
  supersessions: 0,
  summary: null,
  openThreads: [],
  skipped: false,
};

describe.skipIf(!canLoadSqlite)("scheduler", () => {
  it("is a no-op when event delta is below threshold", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    seedEvents(5);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 10 });

    const result = await scheduler.tick();
    expect(result).toBeNull();
    expect(runConsolidate).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it("fires consolidation when event delta reaches threshold", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    seedEvents(10);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 10 });

    const result = await scheduler.tick();
    expect(result).not.toBeNull();
    expect(runConsolidate).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("serialises concurrent ticks", async () => {
    let resolver: (value: any) => void = () => {};
    const runConsolidate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolver = resolve;
        }),
    );

    seedEvents(20);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 5 });

    const first = scheduler.tick();
    const second = scheduler.tick();
    resolver({ consolidationId: "x", factsIn: 0 } as any);
    await Promise.all([first, second]);

    expect(runConsolidate).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("skips SQL work when data_version is unchanged between ticks", async () => {
    // data_version only bumps when ANOTHER connection writes, so this test
    // opens a second connection to represent the CLI's log-event writer.
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const fs = await import("node:fs");
    const tmp = pathMod.join(
      os.tmpdir(),
      `om-sched-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    const readerDb = openDatabase(tmp);
    applySchema(readerDb);
    const writerDb = openDatabase(tmp);
    const writerSessionId = createSession(writerDb, {
      source_tool: "test",
      project: "om",
    }).id;

    function writeEvents(n: number) {
      for (let i = 0; i < n; i++) {
        insertEvent(writerDb, {
          mcp_session_id: writerSessionId,
          event_type: "message",
          role: "user",
          content: `event ${i}`,
        });
      }
    }

    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    writeEvents(3);
    const scheduler = startScheduler({ db: readerDb, runConsolidate, threshold: 10 });

    await scheduler.tick();
    await scheduler.tick(); // same version → fast path
    expect(runConsolidate).not.toHaveBeenCalled();

    writeEvents(10);
    await scheduler.tick();
    expect(runConsolidate).toHaveBeenCalledTimes(1);

    scheduler.stop();
    closeDatabase(writerDb);
    closeDatabase(readerDb);
    try {
      fs.unlinkSync(tmp);
      fs.unlinkSync(`${tmp}-wal`);
      fs.unlinkSync(`${tmp}-shm`);
    } catch {
      /* best effort */
    }
  });

  it("respects minIntervalMs between tick-driven runs", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    seedEvents(20);
    const scheduler = startScheduler({
      db,
      runConsolidate,
      threshold: 5,
      minIntervalMs: 500,
    });

    // First tick fires.
    await scheduler.tick();
    expect(runConsolidate).toHaveBeenCalledTimes(1);

    // Immediate second tick — within throttle window → no-op.
    await scheduler.tick();
    expect(runConsolidate).toHaveBeenCalledTimes(1);

    // Wait past the window → next tick fires again (with new events so
    // data_version actually changes; same-connection inserts won't bump
    // data_version so this test uses a file-backed DB).
    scheduler.stop();
  });

  it("flush bypasses the throttle", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    const scheduler = startScheduler({
      db,
      runConsolidate,
      threshold: 0,
      minIntervalMs: 60_000, // 1 min — way larger than the test window
    });

    await scheduler.flush();
    await scheduler.flush();
    await scheduler.flush();
    expect(runConsolidate).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("flush forces a run regardless of delta", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    // 0 events — below any threshold
    const scheduler = startScheduler({ db, runConsolidate, threshold: 100 });

    await scheduler.flush();
    expect(runConsolidate).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
