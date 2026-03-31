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
const { extractContentFromHookPayload } = canLoadSqlite
  ? await import("../../src/cli/log-event.js")
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

describe.skipIf(!canLoadSqlite)("extractContentFromHookPayload", () => {
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

describe.skipIf(!canLoadSqlite)("logEvent (function)", () => {
  // Note: the logEvent function opens its own database connection from a file path,
  // so we test extractContentFromHookPayload directly (which is the pure logic)
  // and rely on the db/sessions tests for insertEvent correctness.
  // End-to-end CLI testing would require a temp directory with a real SQLite file.

  it("getLatestSession finds the most recent session", () => {
    dbMod.createSession(db, { source_tool: "claude-code", project: null });
    const latest = dbMod.getLatestSession(db);
    expect(latest).not.toBeNull();
    expect(latest!.source_tool).toBe("claude-code");
  });
});
