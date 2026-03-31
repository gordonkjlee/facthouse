import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

// Skip when native bindings are unavailable.
let canLoadSqlite = false;
try {
  const Db = (await import("better-sqlite3")).default;
  const probe = new Db(":memory:");
  probe.close();
  canLoadSqlite = true;
} catch {
  // Native bindings not compiled.
}

const dbMod = canLoadSqlite ? await import("../../src/db/index.js") : ({} as any);
const { createSessionManager } = canLoadSqlite
  ? await import("../../src/tools/session-manager.js")
  : ({} as any);

let db: Database.Database;

beforeEach(() => {
  if (!canLoadSqlite) return;
  db = dbMod.openDatabase(":memory:");
  dbMod.applySchema(db);
});

afterEach(() => {
  if (!canLoadSqlite) return;
  dbMod.closeDatabase(db);
});

describe.skipIf(!canLoadSqlite)("session manager", () => {
  it("starts a session and returns it via getActiveSession", () => {
    const manager = createSessionManager(db);
    expect(manager.getActiveSession()).toBeNull();

    const session = manager.startSession("claude-code", "openmemory");
    expect(session.id).toBeTruthy();
    expect(session.source_tool).toBe("claude-code");
    expect(session.project).toBe("openmemory");
    expect(manager.getActiveSession()).toEqual(session);
  });

  it("logEvent creates an event with correct fields", () => {
    const manager = createSessionManager(db);
    manager.startSession("cursor", null);

    const event = manager.logEvent({
      event_type: "message",
      role: "user",
      content: "hello world",
    });

    expect(event.event_type).toBe("message");
    expect(event.role).toBe("user");
    expect(event.content).toBe("hello world");
    expect(event.sequence).toBe(1);
    expect(event.content_type).toBe("text");
  });

  it("logEvent auto-increments sequence numbers", () => {
    const manager = createSessionManager(db);
    manager.startSession(null, null);

    const e1 = manager.logEvent({ event_type: "message", role: "user", content: "a" });
    const e2 = manager.logEvent({ event_type: "message", role: "assistant", content: "b" });
    const e3 = manager.logEvent({ event_type: "tool_call", role: "assistant", content: "c" });

    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
    expect(e3.sequence).toBe(3);
  });

  it("logEvent updates session last_activity_at", () => {
    const manager = createSessionManager(db);
    const session = manager.startSession(null, null);
    const before = session.last_activity_at;

    manager.logEvent({ event_type: "message", role: "user", content: "hello" });

    const updated = manager.getActiveSession()!;
    expect(updated.last_activity_at >= before).toBe(true);
  });

  it("logEvent throws if no session started", () => {
    const manager = createSessionManager(db);

    expect(() =>
      manager.logEvent({ event_type: "message", role: "user", content: "hello" }),
    ).toThrow("No active session");
  });
});


describe.skipIf(!canLoadSqlite)("get_events read tool", () => {
  it("returns events from the current session", () => {
    const manager = createSessionManager(db);
    manager.startSession(null, null);

    manager.logEvent({ event_type: "message", role: "user", content: "hello" });
    manager.logEvent({ event_type: "message", role: "assistant", content: "hi there" });

    const sessionId = manager.getActiveSession()!.id;
    const events = dbMod.getEvents(db, sessionId);

    expect(events).toHaveLength(2);
    expect(events[0].content).toBe("hello");
    expect(events[1].content).toBe("hi there");
  });

  it("respects after_sequence for pagination", () => {
    const manager = createSessionManager(db);
    manager.startSession(null, null);

    for (let i = 0; i < 5; i++) {
      manager.logEvent({ event_type: "message", role: "user", content: `msg ${i}` });
    }

    const sessionId = manager.getActiveSession()!.id;
    const page = dbMod.getEvents(db, sessionId, { after_sequence: 3, limit: 10 });

    expect(page).toHaveLength(2);
    expect(page[0].sequence).toBe(4);
    expect(page[1].sequence).toBe(5);
  });
});
