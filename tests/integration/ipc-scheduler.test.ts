/**
 * Integration test: IPC signal → scheduler tick/flush → runConsolidate.
 *
 * Unit tests cover each layer in isolation. This test composes them
 * together to catch wiring bugs that don't surface in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
const { startScheduler } = canLoadSqlite
  ? await import("../../src/scheduler.js")
  : ({} as any);
const { startSchedulerListener, sendSchedulerSignal } = canLoadSqlite
  ? await import("../../src/ipc/scheduler-ipc.js")
  : ({} as any);

let dir: string;
let db: Database.Database;
let sessionId: string;

beforeEach(() => {
  if (!canLoadSqlite) return;
  dir = mkdtempSync(path.join(tmpdir(), "om-int-"));
  db = openDatabase(path.join(dir, "memory.db"));
  applySchema(db);
  sessionId = createSession(db, { source_tool: "test", project: "om" }).id;
});

afterEach(() => {
  if (!canLoadSqlite) return;
  closeDatabase(db);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe.skipIf(!canLoadSqlite)("IPC → scheduler integration", () => {
  it("a tick signal above threshold fires the scheduler", async () => {
    const runConsolidate = vi.fn().mockResolvedValue({
      consolidationId: "r1",
      factsIn: 0,
      factsGraduated: 0,
      factsRejected: 0,
      entitiesCreated: 0,
      entitiesLinked: 0,
      supersessions: 0,
      summary: null,
      openThreads: [],
      skipped: false,
    });

    const scheduler = startScheduler({ db, runConsolidate, threshold: 5 });
    const listener = await startSchedulerListener(dir, (kind) => {
      if (kind === "flush") void scheduler.flush();
      else void scheduler.tick();
    });

    try {
      // Writer connection simulates the log-event CLI — events must come from
      // a different connection or data_version won't bump.
      const writerDb = openDatabase(path.join(dir, "memory.db"));
      const writerSession = createSession(writerDb, {
        source_tool: "cli",
        project: "om",
      }).id;
      for (let i = 0; i < 5; i++) {
        insertEvent(writerDb, {
          mcp_session_id: writerSession,
          event_type: "message",
          role: "user",
          content: `event ${i}`,
        });
      }
      closeDatabase(writerDb);

      const delivered = await sendSchedulerSignal(dir, "tick");
      expect(delivered).toBe(true);

      // Give the listener's async callback time to reach runConsolidate.
      await new Promise((r) => setTimeout(r, 100));
      expect(runConsolidate).toHaveBeenCalledTimes(1);
    } finally {
      listener.close();
      scheduler.stop();
    }
  });

  it("a tick signal below threshold does not fire the scheduler", async () => {
    const runConsolidate = vi.fn();
    const scheduler = startScheduler({ db, runConsolidate, threshold: 100 });
    const listener = await startSchedulerListener(dir, (kind) => {
      if (kind === "flush") void scheduler.flush();
      else void scheduler.tick();
    });

    try {
      const writerDb = openDatabase(path.join(dir, "memory.db"));
      const writerSession = createSession(writerDb, {
        source_tool: "cli",
        project: "om",
      }).id;
      insertEvent(writerDb, {
        mcp_session_id: writerSession,
        event_type: "message",
        role: "user",
        content: "just one event",
      });
      closeDatabase(writerDb);

      await sendSchedulerSignal(dir, "tick");
      await new Promise((r) => setTimeout(r, 100));
      expect(runConsolidate).not.toHaveBeenCalled();
    } finally {
      listener.close();
      scheduler.stop();
    }
  });

  it("a flush signal fires the scheduler regardless of threshold", async () => {
    const runConsolidate = vi.fn().mockResolvedValue({
      consolidationId: "r1",
      factsIn: 0,
      factsGraduated: 0,
      factsRejected: 0,
      entitiesCreated: 0,
      entitiesLinked: 0,
      supersessions: 0,
      summary: null,
      openThreads: [],
      skipped: false,
    });
    const scheduler = startScheduler({ db, runConsolidate, threshold: 1000 });
    const listener = await startSchedulerListener(dir, (kind) => {
      if (kind === "flush") void scheduler.flush();
      else void scheduler.tick();
    });

    try {
      // Zero events — flush should still fire.
      const delivered = await sendSchedulerSignal(dir, "flush");
      expect(delivered).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(runConsolidate).toHaveBeenCalledTimes(1);
    } finally {
      listener.close();
      scheduler.stop();
    }
  });

  it("sendSchedulerSignal returns false when no MCP server is listening", async () => {
    // No startSchedulerListener — emulates MCP server not running.
    const delivered = await sendSchedulerSignal(dir, "tick", 200);
    expect(delivered).toBe(false);
  });
});
