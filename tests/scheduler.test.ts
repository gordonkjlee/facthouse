import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Db } from "../src/db/connection.js";

// ---------------------------------------------------------------------------
// Guard: skip when native bindings are unavailable
// ---------------------------------------------------------------------------


const { openDatabase, closeDatabase } = await import("../src/db/connection.js");
const { applySchema } = await import("../src/db/schema.js");
const { createSession, insertEvent } = await import("../src/db/sessions.js");
const { startScheduler } = await import("../src/scheduler.js");

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

describe("scheduler", () => {
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
    expect(runConsolidate).toHaveBeenCalledWith("extract");

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
    // An explicit budget, because this is the only test in the file that touches
    // real disk — two SQLite connections against a temp file, where the rest run
    // in memory. It takes ~114ms locally and exceeded the 5s default once on a
    // loaded CI runner, which failed the test step that gates npm publication:
    // an otherwise sound release did not reach users because a filesystem test
    // was starved of I/O. Not a race — it is consistently fast and correct, just
    // far more expensive than the default budget was set for.
  }, 30_000);

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
    expect(runConsolidate).toHaveBeenCalledWith("graduate");
    scheduler.stop();
  });

  it("full forces extract then graduate", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 100 });
    await scheduler.full();
    expect(runConsolidate).toHaveBeenCalledWith("full");
    scheduler.stop();
  });
});
