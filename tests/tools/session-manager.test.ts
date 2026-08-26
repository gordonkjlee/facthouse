import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const dbMod = await import("../../src/db/index.js");
const { createSessionManager, withEventLogging } = await import("../../src/tools/session-manager.js");

let db: Db;

beforeEach(async () => {
  db = dbMod.openDatabase(":memory:");
  await dbMod.applySchema(db);
});

afterEach(async () => {
  await dbMod.closeDatabase(db);
});

describe("session manager", () => {
  it("starts a session and returns it via getActiveSession", async () => {
    const manager = createSessionManager(db);
    expect(manager.getActiveSession()).toBeNull();

    const session = await manager.startSession("claude-code", "openmemory");
    expect(session.id).toBeTruthy();
    expect(session.source_tool).toBe("claude-code");
    expect(session.project).toBe("openmemory");
    expect(manager.getActiveSession()).toEqual(session);
  });

  it("logEvent creates an event with correct fields", async () => {
    const manager = createSessionManager(db);
    await manager.startSession("cursor", null);

    const event = await manager.logEvent({
      event_type: "message",
      role: "user",
      content: "hello world",
    });

    expect(event.event_type).toBe("message");
    expect(event.role).toBe("user");
    expect(event.content).toBe("hello world");
    expect(event.sequence).toBe(1);
    expect(event.content_type).toBe("text");
    expect(event.speaker).toBeNull();
    expect(event.occurred_at).not.toBeNull();
    expect(
      Math.abs(Date.parse(event.occurred_at!) - Date.parse(event.created_at)),
    ).toBeLessThan(1000);
  });

  it("logEvent auto-increments sequence numbers", async () => {
    const manager = createSessionManager(db);
    await manager.startSession(null, null);

    const e1 = await manager.logEvent({ event_type: "message", role: "user", content: "a" });
    const e2 = await manager.logEvent({ event_type: "message", role: "assistant", content: "b" });
    const e3 = await manager.logEvent({ event_type: "tool_call", role: "assistant", content: "c" });

    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
    expect(e3.sequence).toBe(3);
  });

  it("logEvent stores a named speaker without changing role", async () => {
    const manager = createSessionManager(db);
    await manager.startSession(null, null);

    const event = await manager.logEvent({
      event_type: "message",
      role: "user",
      content: "the grain is bookings",
      speaker: "Alex",
    });

    expect(event.role).toBe("user");
    expect(event.speaker).toBe("Alex");
  });

  it("logEvent updates session last_activity_at", async () => {
    const manager = createSessionManager(db);
    const session = await manager.startSession(null, null);
    const before = session.last_activity_at;

    await manager.logEvent({ event_type: "message", role: "user", content: "hello" });

    const updated = manager.getActiveSession()!;
    expect(updated.last_activity_at >= before).toBe(true);
  });

  it("logEvent throws if no session started", async () => {
    const manager = createSessionManager(db);

    await expect(
      manager.logEvent({ event_type: "message", role: "user", content: "hello" }),
    ).rejects.toThrow("No active session");
  });
});

describe("withEventLogging", () => {
  it("wraps a sync handler and logs tool_call + tool_result", async () => {
    const manager = createSessionManager(db);
    await manager.startSession(null, null);

    const handler = (args: any) => ({
      content: [{ type: "text" as const, text: `result for ${args.query}` }],
    });

    const wrapped = withEventLogging(manager, "search_knowledge", handler);
    const result = await wrapped({ query: "allergies" });

    expect(result.content[0].text).toBe("result for allergies");

    // Should have logged 2 events: tool_call + tool_result
    const events = await dbMod.getEvents(db, manager.getActiveSession()!.id);
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe("tool_call");
    expect(events[0].role).toBe("assistant");
    expect(events[1].event_type).toBe("tool_result");
    expect(events[1].role).toBe("tool");
    expect(events[1].metadata).toEqual({ tool: "search_knowledge" });
  });

  it("wraps an async handler", async () => {
    const manager = createSessionManager(db);
    await manager.startSession(null, null);

    const handler = async (args: any) => ({
      content: [{ type: "text" as const, text: "async result" }],
    });

    const wrapped = withEventLogging(manager, "async_tool", handler);
    const result = await wrapped({});

    expect(result.content[0].text).toBe("async result");

    const events = await dbMod.getEvents(db, manager.getActiveSession()!.id);
    expect(events).toHaveLength(2);
  });
});

describe("get_events read tool", () => {
  it("returns events from the current session", async () => {
    const manager = createSessionManager(db);
    await manager.startSession(null, null);

    await manager.logEvent({ event_type: "message", role: "user", content: "hello" });
    await manager.logEvent({ event_type: "message", role: "assistant", content: "hi there" });

    const sessionId = manager.getActiveSession()!.id;
    const events = await dbMod.getEvents(db, sessionId);

    expect(events).toHaveLength(2);
    expect(events[0].content).toBe("hello");
    expect(events[1].content).toBe("hi there");
  });

  it("respects after_sequence for pagination", async () => {
    const manager = createSessionManager(db);
    await manager.startSession(null, null);

    for (let i = 0; i < 5; i++) {
      await manager.logEvent({ event_type: "message", role: "user", content: `msg ${i}` });
    }

    const sessionId = manager.getActiveSession()!.id;
    const page = await dbMod.getEvents(db, sessionId, { after_sequence: 3, limit: 10 });

    expect(page).toHaveLength(2);
    expect(page[0].sequence).toBe(4);
    expect(page[1].sequence).toBe(5);
  });
});
