import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "../../src/db/connection.js";


const dbMod = await import("../../src/db/index.js");
const { extractContentFromHookPayload, logEvent } = await import("../../src/cli/log-event.js");

let db: Db;

beforeEach(() => {
  db = dbMod.openDatabase(":memory:");
  dbMod.applySchema(db);
});

afterEach(() => {
  dbMod.closeDatabase(db);
});

describe("extractContentFromHookPayload", () => {
  it("extracts prompt from UserPromptSubmit hook", () => {
    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "What is the capital of France?",
      session_id: "abc-123",
    });

    const result = extractContentFromHookPayload(payload);
    expect(result.content).toBe("What is the capital of France?");
    expect(result.sessionId).toBe("abc-123");
  });

  it("extracts last_assistant_message from Stop hook", () => {
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      last_assistant_message: "The capital is Paris.",
      session_id: "abc-123",
    });

    const result = extractContentFromHookPayload(payload);
    expect(result.content).toBe("The capital is Paris.");
  });

  it("returns raw JSON for unknown hook events", () => {
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    const result = extractContentFromHookPayload(payload);
    expect(result.content).toBe(payload);
  });

  it("returns raw text for non-JSON input", () => {
    const result = extractContentFromHookPayload("plain text input");
    expect(result.content).toBe("plain text input");
    expect(result.sessionId).toBeUndefined();
  });

  it("handles missing content field gracefully", () => {
    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      // prompt field missing
      session_id: "abc",
    });

    const result = extractContentFromHookPayload(payload);
    // Falls back to raw JSON when the expected field is missing.
    expect(result.content).toBe(payload);
  });
});

describe("logEvent (function)", () => {
  it("getLatestSession finds the most recent session", () => {
    dbMod.createSession(db, { source_tool: "claude-code", project: null });
    const latest = dbMod.getLatestSession(db);
    expect(latest).not.toBeNull();
    expect(latest!.source_tool).toBe("claude-code");
  });
});

describe("logEvent attributes every event to a session", () => {
  /**
   * An event with both session columns null is not just untidy — consolidation's
   * event-extraction pass resolves a session from the batch it is reading and
   * returns early when it finds none, so such an event is never read at all.
   *
   * That was the behaviour for any call without a session id, which includes the
   * manual form the README documents. Events accumulated, consolidation reported
   * zero facts, and neither end said anything was wrong. These tests assert the
   * invariant that makes an event reachable, not the shape of the row.
   */
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "om-logevent-"));
    dataDir = path.join(root, "store");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Read the events back through a fresh connection, as consolidation would. */
  function readEvents(): Array<{ mcp_session_id: string | null; client_session_id: string | null }> {
    const conn = dbMod.openDatabase(path.join(dataDir, "memory.db"));
    try {
      return conn
        .prepare(`SELECT mcp_session_id, client_session_id FROM session_events ORDER BY sequence`)
        .all() as any[];
    } finally {
      dbMod.closeDatabase(conn);
    }
  }

  it("refuses postgres before creating memory.db", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    await expect(
      logEvent({
        role: "user",
        eventType: "message",
        content: "the grain is bookings",
        dataDir,
      }),
    ).rejects.toThrow(/postgres/);
    expect(existsSync(path.join(dataDir, "memory.db"))).toBe(false);
  });

  it("attaches an event to a session on a store that has none", async () => {
    await logEvent({
      role: "user",
      eventType: "message",
      content: "Robin is leading the Atlas migration.",
      dataDir,
    });

    const [event] = readEvents();
    // The precondition consolidation checks. Null here means never extracted.
    expect(event.mcp_session_id).not.toBeNull();
  });

  it("reuses the latest session instead of one per event", async () => {
    for (const content of ["first message", "second message", "third message"]) {
      await logEvent({ role: "user", eventType: "message", content, dataDir });
    }

    const events = readEvents();
    expect(events).toHaveLength(3);
    // All three in one conversation — otherwise working memory, which scopes to
    // a single session, sees each event in isolation.
    const sessions = new Set(events.map((e) => e.mcp_session_id));
    expect(sessions.size).toBe(1);
    // ...and one *real* session. A set of three nulls also has size 1, so
    // without this the assertion above passes on exactly the bug it guards.
    expect([...sessions][0]).not.toBeNull();
  });

  it("stores a named speaker on the event", async () => {
    await logEvent({
      role: "user",
      eventType: "message",
      content: "the grain is bookings",
      speaker: "Alex",
      dataDir,
    });
    const conn = dbMod.openDatabase(path.join(dataDir, "memory.db"));
    try {
      const row = conn
        .prepare(`SELECT speaker, role FROM session_events`)
        .get() as { speaker: string | null; role: string };
      expect(row.role).toBe("user");
      expect(row.speaker).toBe("Alex");
    } finally {
      dbMod.closeDatabase(conn);
    }
  });

  it("stamps occurred_at as hook time, not null", async () => {
    const before = new Date().toISOString();
    await logEvent({
      role: "user",
      eventType: "message",
      content: "from a hook",
      sessionId: "client-abc-123",
      dataDir,
    });
    const conn = dbMod.openDatabase(path.join(dataDir, "memory.db"));
    try {
      const row = conn
        .prepare(
          `SELECT occurred_at, created_at FROM session_events WHERE client_session_id = ?`,
        )
        .get("client-abc-123") as { occurred_at: string | null; created_at: string };
      expect(row.occurred_at).not.toBeNull();
      expect(row.occurred_at! >= before).toBe(true);
      // Live capture: said and ingested are the same instant, give or take
      // the millisecond between the two Date.now calls.
      expect(Math.abs(Date.parse(row.occurred_at!) - Date.parse(row.created_at))).toBeLessThan(
        1000,
      );
    } finally {
      dbMod.closeDatabase(conn);
    }
  });

  it("keeps a hook-supplied session id as the client's own", async () => {
    await logEvent({
      role: "user",
      eventType: "message",
      content: "from a hook",
      sessionId: "client-abc-123",
      dataDir,
    });

    const [event] = readEvents();
    expect(event.client_session_id).toBe("client-abc-123");
    // Not invented as one of ours — the client's id is opaque to us.
    expect(event.mcp_session_id).toBeNull();
  });

  it("records OPENMEMORY_PROJECT on the session as provenance", async () => {
    const previous = process.env.OPENMEMORY_PROJECT;
    process.env.OPENMEMORY_PROJECT = "atlas";
    try {
      await logEvent({
        role: "user",
        eventType: "message",
        content: "from a hook",
        sessionId: "client-abc-123",
        dataDir,
      });
      const conn = dbMod.openDatabase(path.join(dataDir, "memory.db"));
      try {
        const row = conn
          .prepare(`SELECT project, source_tool FROM sessions WHERE id = ?`)
          .get("client-abc-123") as { project: string; source_tool: string };
        expect(row.project).toBe("atlas");
        expect(row.source_tool).toBe("cli");
      } finally {
        dbMod.closeDatabase(conn);
      }
    } finally {
      if (previous === undefined) delete process.env.OPENMEMORY_PROJECT;
      else process.env.OPENMEMORY_PROJECT = previous;
    }
  });

  it("the most-recent fallback is not how pull attributes conversations", async () => {
    await logEvent({
      role: "user",
      eventType: "message",
      content: "manual, no session id",
      dataDir,
    });
    await logEvent({
      role: "user",
      eventType: "message",
      content: "from a hook",
      sessionId: "sess-aaa",
      dataDir,
    });

    const events = readEvents();
    expect(events[0].mcp_session_id).not.toBeNull();
    expect(events[0].client_session_id).toBeNull();
    expect(events[1].client_session_id).toBe("sess-aaa");
    expect(events[1].mcp_session_id).toBeNull();
    // Distinct conversations. Pull writes the same shape as the second row
    // and never calls getLatestSession — see extract-by-session tests.
    expect(events[0].mcp_session_id).not.toBe(events[1].client_session_id);
  });
});
