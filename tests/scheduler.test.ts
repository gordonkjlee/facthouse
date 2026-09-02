import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Db } from "../src/db/connection.js";

const { openDatabase, closeDatabase } = await import("../src/db/connection.js");
const { applySchema } = await import("../src/db/schema.js");
const { createSession, insertEvent } = await import("../src/db/sessions.js");
const { startScheduler } = await import("../src/scheduler.js");
const { MOMENT_POLICY } = await import("../src/intelligence/steps.js");

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

async function seedEvents(n: number) {
  for (let i = 0; i < n; i++) {
    await insertEvent(db, {
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
  factsIntegrated: 0,
  factsRejected: 0,
  entitiesCreated: 0,
  entitiesLinked: 0,
  supersessions: 0,
  eventsCopied: 0,
  eventsRemaining: 0,
  summary: null,
  openThreads: [],
  skipped: false,
  examinedThrough: 0,
};

describe("scheduler", () => {
  it("threshold is a no-op when the unexamined count is below threshold", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    await seedEvents(5);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 10 });

    const result = await scheduler.run("threshold");
    expect(result).toBeNull();
    expect(runConsolidate).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it("threshold runs extract only once the count reaches threshold", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    await seedEvents(10);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 10 });

    const result = await scheduler.run("threshold");
    expect(result).not.toBeNull();
    expect(runConsolidate).toHaveBeenCalledTimes(1);
    expect(runConsolidate).toHaveBeenCalledWith(
      { copy: false, extract: true, integrate: false },
      "threshold",
    );

    scheduler.stop();
  });

  it("serialises concurrent moments", async () => {
    let resolver: (value: any) => void = () => {};
    const runConsolidate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolver = resolve;
        }),
    );

    await seedEvents(20);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 5 });

    const first = scheduler.run("threshold");
    const second = scheduler.run("threshold");
    // run() awaits SQL before calling runConsolidate; resolve once it has.
    while (runConsolidate.mock.calls.length === 0) {
      await Promise.resolve();
    }
    resolver({ consolidationId: "x", factsIn: 0 } as any);
    await Promise.all([first, second]);

    expect(runConsolidate).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("skips SQL work when data_version is unchanged between threshold moments", async () => {
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
    await applySchema(readerDb);
    const writerDb = openDatabase(tmp);
    const writerSessionId = (await createSession(writerDb, {
      source_tool: "test",
      project: "om",
    })).id;

    async function writeEvents(n: number) {
      for (let i = 0; i < n; i++) {
        await insertEvent(writerDb, {
          mcp_session_id: writerSessionId,
          event_type: "message",
          role: "user",
          content: `event ${i}`,
        });
      }
    }

    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    await writeEvents(3);
    const scheduler = startScheduler({ db: readerDb, runConsolidate, threshold: 10 });

    await scheduler.run("threshold");
    await scheduler.run("threshold"); // same version → fast path
    expect(runConsolidate).not.toHaveBeenCalled();

    await writeEvents(10);
    await scheduler.run("threshold");
    expect(runConsolidate).toHaveBeenCalledTimes(1);

    scheduler.stop();
    await closeDatabase(writerDb);
    await closeDatabase(readerDb);
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
    // loaded CI runner, which failed the test step that gates npm publication.
  }, 30_000);

  it("respects minIntervalMs between threshold-driven runs", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    await seedEvents(20);
    const scheduler = startScheduler({
      db,
      runConsolidate,
      threshold: 5,
      minIntervalMs: 500,
    });

    await scheduler.run("threshold");
    expect(runConsolidate).toHaveBeenCalledTimes(1);

    // Immediate second moment — within throttle window → no-op.
    await scheduler.run("threshold");
    expect(runConsolidate).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("compaction bypasses the throttle", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    const scheduler = startScheduler({
      db,
      runConsolidate,
      threshold: 0,
      minIntervalMs: 60_000, // 1 min — way larger than the test window
    });

    await scheduler.run("compaction");
    await scheduler.run("compaction");
    await scheduler.run("compaction");
    expect(runConsolidate).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("compaction runs every step regardless of the unexamined count", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);

    // 0 events — below any threshold
    const scheduler = startScheduler({ db, runConsolidate, threshold: 100 });

    await scheduler.run("compaction");
    expect(runConsolidate).toHaveBeenCalledTimes(1);
    expect(runConsolidate).toHaveBeenCalledWith(
      { copy: true, extract: true, integrate: true },
      "compaction",
    );
    scheduler.stop();
  });

  it("shutdown integrates only: no model pass over D when the process is ending", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 100 });
    await scheduler.run("shutdown");
    expect(runConsolidate).toHaveBeenCalledWith(
      { copy: false, extract: false, integrate: true },
      "shutdown",
    );
    scheduler.stop();
  });

  it("session_start runs every step, forced", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 100 });
    await scheduler.run("session_start");
    expect(runConsolidate).toHaveBeenCalledWith(
      { copy: true, extract: true, integrate: true },
      "session_start",
    );
    scheduler.stop();
  });

  it("passes a copy of the policy steps, never the frozen table", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 100 });
    await scheduler.run("manual");
    const passed = runConsolidate.mock.calls[0]![0];
    expect(passed).toEqual(MOMENT_POLICY.manual.steps);
    expect(passed).not.toBe(MOMENT_POLICY.manual.steps);
    scheduler.stop();
  });
});
