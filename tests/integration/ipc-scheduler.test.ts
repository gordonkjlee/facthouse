/**
 * Integration test: notify → scheduler.run(moment) → runConsolidate.
 *
 * Unit tests cover each layer in isolation. This test composes them
 * together to catch wiring bugs that don't surface in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession, insertEvent } = await import("../../src/db/sessions.js");
const { startScheduler } = await import("../../src/scheduler.js");
const { startNotifyListener, notifyServer } = await import(
  "../../src/ipc/scheduler-ipc.js"
);

let dir: string;
let db: Db;
let sessionId: string;

const STUB_RESULT = {
  consolidationId: "r1",
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

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "om-int-"));
  db = openDatabase(path.join(dir, "memory.db"));
  await applySchema(db);
  sessionId = (await createSession(db, { source_tool: "test", project: "om" })).id;
});

afterEach(async () => {
  await closeDatabase(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function writeEventsFromAnotherConnection(n: number) {
  // Writer connection simulates the record CLI — events must come from
  // a different connection or data_version won't bump.
  const writerDb = openDatabase(path.join(dir, "memory.db"));
  const writerSession = (await createSession(writerDb, {
    source_tool: "cli",
    project: "om",
  })).id;
  for (let i = 0; i < n; i++) {
    await insertEvent(writerDb, {
      mcp_session_id: writerSession,
      event_type: "message",
      role: "user",
      content: `event ${i}`,
    });
  }
  await closeDatabase(writerDb);
}

describe("notify → scheduler integration", () => {
  it("a threshold moment above threshold runs extract", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 5 });
    const listener = await startNotifyListener(dir, (moment) => {
      void scheduler.run(moment);
    });

    try {
      await writeEventsFromAnotherConnection(5);

      const delivered = await notifyServer(dir, "threshold");
      expect(delivered).toBe(true);

      // Give the listener's async callback time to reach runConsolidate.
      await new Promise((r) => setTimeout(r, 100));
      expect(runConsolidate).toHaveBeenCalledTimes(1);
      expect(runConsolidate).toHaveBeenCalledWith(
        { copy: false, extract: true, integrate: false },
        "threshold",
      );
    } finally {
      listener.close();
      scheduler.stop();
    }
  });

  it("a threshold moment below threshold does nothing", async () => {
    const runConsolidate = vi.fn();
    const scheduler = startScheduler({ db, runConsolidate, threshold: 100 });
    const listener = await startNotifyListener(dir, (moment) => {
      void scheduler.run(moment);
    });

    try {
      await writeEventsFromAnotherConnection(1);
      await notifyServer(dir, "threshold");
      await new Promise((r) => setTimeout(r, 100));
      expect(runConsolidate).not.toHaveBeenCalled();
    } finally {
      listener.close();
      scheduler.stop();
    }
  });

  it("a compaction moment runs every step regardless of threshold", async () => {
    const runConsolidate = vi.fn().mockResolvedValue(STUB_RESULT);
    const scheduler = startScheduler({ db, runConsolidate, threshold: 1000 });
    const listener = await startNotifyListener(dir, (moment) => {
      void scheduler.run(moment);
    });

    try {
      // Zero events — compaction still fires, and copies first.
      const delivered = await notifyServer(dir, "compaction");
      expect(delivered).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(runConsolidate).toHaveBeenCalledTimes(1);
      expect(runConsolidate).toHaveBeenCalledWith(
        { copy: true, extract: true, integrate: true },
        "compaction",
      );
    } finally {
      listener.close();
      scheduler.stop();
    }
  });

  it("notifyServer returns false when no MCP server is listening", async () => {
    // No listener — emulates the MCP server not running.
    const delivered = await notifyServer(dir, "threshold", 200);
    expect(delivered).toBe(false);
  });
});
