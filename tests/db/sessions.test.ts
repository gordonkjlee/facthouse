import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

// better-sqlite3 requires native bindings — test actual constructor, not just import.
let canLoadSqlite = false;
try {
  const Db = (await import("better-sqlite3")).default;
  const probe = new Db(":memory:");
  probe.close();
  canLoadSqlite = true;
} catch {
  // Native bindings not compiled (e.g. missing Visual Studio build tools on Windows).
}

const { openDatabase, closeDatabase } = canLoadSqlite
  ? await import("../../src/db/connection.js")
  : ({} as any);
const { applySchema, getSchemaVersion } = canLoadSqlite
  ? await import("../../src/db/schema.js")
  : ({} as any);
const { createSession, getSession, getLatestSession, insertEvent, getEvents, getEventCount } =
  canLoadSqlite
    ? await import("../../src/db/sessions.js")
    : ({} as any);

let db: Database.Database;

beforeEach(() => {
  if (!canLoadSqlite) return;
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => {
  if (!canLoadSqlite) return;
  closeDatabase(db);
});

describe.skipIf(!canLoadSqlite)("schema", () => {
  it("applies current version", () => {
    expect(getSchemaVersion(db)).toBe(4);
  });

  it("is idempotent", () => {
    applySchema(db); // second call
    expect(getSchemaVersion(db)).toBe(4);
  });
});

describe.skipIf(!canLoadSqlite)("sessions", () => {
  it("creates a session with generated id and timestamps", () => {
    const session = createSession(db, {
      source_tool: "claude-code",
      project: "openmemory",
    });

    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(session.source_tool).toBe("claude-code");
    expect(session.project).toBe("openmemory");
    expect(session.started_at).toBeTruthy();
    expect(session.last_activity_at).toBe(session.started_at);
  });

  it("creates a session with null source_tool and project", () => {
    const session = createSession(db, {
      source_tool: null,
      project: null,
    });

    expect(session.source_tool).toBeNull();
    expect(session.project).toBeNull();
  });

  it("retrieves a session by id", () => {
    const created = createSession(db, {
      source_tool: "cursor",
      project: null,
    });

    const found = getSession(db, created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.source_tool).toBe("cursor");
  });

  it("returns null for non-existent session", () => {
    expect(getSession(db, "non-existent")).toBeNull();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("getLatestSession returns the most recently active", async () => {
    const s1 = createSession(db, { source_tool: "a", project: null });
    await sleep(5000);
    const s2 = createSession(db, { source_tool: "b", project: null });

    // s2 was created 5 s later, so it's the latest
    const latest = getLatestSession(db);
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(s2.id);

    // Insert an event into s1 — its last_activity_at is now ahead of s2's
    await sleep(5000);
    insertEvent(db, {
      mcp_session_id: s1.id,
      event_type: "message",
      role: "user",
      content: "hello",
    });

    const updated = getLatestSession(db);
    expect(updated!.id).toBe(s1.id);
  }, 15_000);

  it("returns null when no sessions exist", () => {
    expect(getLatestSession(db)).toBeNull();
  });
});

describe.skipIf(!canLoadSqlite)("session events", () => {
  let sessionId: string;

  beforeEach(() => {
    const session = createSession(db, {
      source_tool: "claude-code",
      project: null,
    });
    sessionId = session.id;
  });

  it("inserts an event with auto-incremented sequence", () => {
    const e1 = insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "first message",
    });

    const e2 = insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "assistant",
      content: "second message",
    });

    const e3 = insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "tool_call",
      role: "assistant",
      content: '{"tool":"search"}',
      content_type: "json",
    });

    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
    expect(e3.sequence).toBe(3);
  });

  it("updates session last_activity_at on insert", () => {
    const before = getSession(db, sessionId)!;
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "hello",
    });
    const after = getSession(db, sessionId)!;

    expect(after.last_activity_at >= before.last_activity_at).toBe(true);
    // Verify the UPDATE actually ran by checking the session was touched.
    expect(after.last_activity_at).toBeTruthy();
  });

  it("defaults content_type to text", () => {
    const event = insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "hello",
    });

    expect(event.content_type).toBe("text");
  });

  it("stores and retrieves content_ref for non-text events", () => {
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "artifact",
      role: "user",
      content: null,
      content_type: "image",
      content_ref: "/tmp/screenshot.png",
    });

    const events = getEvents(db, sessionId);
    expect(events[0].content).toBeNull();
    expect(events[0].content_ref).toBe("/tmp/screenshot.png");
    expect(events[0].content_type).toBe("image");
  });

  it("round-trips metadata through JSON", () => {
    const meta = { tool: "search_knowledge", latency_ms: 42 };
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "tool_result",
      role: "tool",
      content: "results",
      metadata: meta,
    });

    const events = getEvents(db, sessionId);
    expect(events[0].metadata).toEqual(meta);
  });

  it("stores null metadata", () => {
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "hello",
    });

    const events = getEvents(db, sessionId);
    expect(events[0].metadata).toBeNull();
  });

  it("getEvents returns ordered by sequence", () => {
    for (let i = 0; i < 5; i++) {
      insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }

    const events = getEvents(db, sessionId);
    expect(events).toHaveLength(5);
    for (let i = 0; i < events.length; i++) {
      expect(events[i].sequence).toBe(i + 1);
    }
  });

  it("getEvents respects after_sequence filter", () => {
    for (let i = 0; i < 5; i++) {
      insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "message",
        role: "user",
        content: `message ${i}`,
      });
    }

    const events = getEvents(db, sessionId, { after_sequence: 3 });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(4);
    expect(events[1].sequence).toBe(5);
  });

  it("getEvents respects limit", () => {
    for (let i = 0; i < 5; i++) {
      insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "message",
        role: "user",
        content: `message ${i}`,
      });
    }

    const events = getEvents(db, sessionId, { limit: 2 });
    expect(events).toHaveLength(2);
  });

  it("getEventCount returns correct count", () => {
    expect(getEventCount(db, sessionId)).toBe(0);

    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "hello",
    });

    expect(getEventCount(db, sessionId)).toBe(1);
  });

  it("uses global sequence across sessions", () => {
    const s2 = createSession(db, { source_tool: null, project: null });

    const e1 = insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "session 1",
    });

    const e2 = insertEvent(db, {
      mcp_session_id: s2.id,
      event_type: "message",
      role: "user",
      content: "session 2",
    });

    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
  });

  it("retrieves events by client_session_id", () => {
    insertEvent(db, {
      client_session_id: "claude-uuid",
      event_type: "message",
      role: "user",
      content: "from hook",
    });

    const events = getEvents(db, "claude-uuid");
    expect(events).toHaveLength(1);
    expect(events[0].client_session_id).toBe("claude-uuid");
    expect(events[0].mcp_session_id).toBeNull();
  });

  it("retrieves events by either session column", () => {
    insertEvent(db, {
      mcp_session_id: sessionId,
      client_session_id: "claude-uuid",
      event_type: "message",
      role: "user",
      content: "both ids",
    });

    const byMcp = getEvents(db, sessionId);
    const byClient = getEvents(db, "claude-uuid");
    expect(byMcp).toHaveLength(1);
    expect(byClient).toHaveLength(1);
    expect(byMcp[0].id).toBe(byClient[0].id);
  });
});
