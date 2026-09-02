import { describe, it, expect } from "vitest";
import { mapTranscriptLine } from "../../src/sources/claude-code.js";

/**
 * Synthetic Claude Code lines — not real user data.
 * Mirrors shapes observed on disk: string content, content-block arrays,
 * tool_result nested in a user turn, thinking blocks, isMeta, UI snapshots.
 */

describe("mapTranscriptLine", () => {
  it("maps a user string as a user message", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "user",
        sessionId: "sess-payload",
        message: { role: "user", content: "The demo store prefers dark mode." },
      }),
      "sess-filename",
      "/tmp/sess-filename.jsonl",
      1,
    );
    expect(events).toHaveLength(1);
    expect(events[0].role).toBe("user");
    expect(events[0].event_type).toBe("message");
    expect(events[0].content).toContain("dark mode");
    expect(events[0].client_session_id).toBe("sess-payload");
    expect(events[0].occurred_at).toBeNull();
    expect(events[0].speaker).toBeNull();
  });

  it("copies speaker from the JSONL line and does not guess userName or author", () => {
    const named = mapTranscriptLine(
      JSON.stringify({
        type: "user",
        sessionId: "sess-payload",
        speaker: "  Alex  ",
        userName: "Robin",
        author: "Sam",
        message: { role: "user", content: "The grain is bookings." },
      }),
      "sess-filename",
      "/tmp/sess-filename.jsonl",
      1,
    );
    expect(named).toHaveLength(1);
    expect(named[0].role).toBe("user");
    expect(named[0].speaker).toBe("Alex");

    const guessed = mapTranscriptLine(
      JSON.stringify({
        type: "user",
        sessionId: "sess-payload",
        userName: "Robin",
        author: "Sam",
        message: { role: "user", content: "The grain is bookings." },
      }),
      "sess-filename",
      "/tmp/sess-filename.jsonl",
      1,
    );
    expect(guessed[0].speaker).toBeNull();

    const cursorShaped = mapTranscriptLine(
      JSON.stringify({
        role: "user",
        speaker: "Alex",
        message: { role: "user", content: "The grain is bookings." },
      }),
      "sess-filename",
      "/tmp/sess-filename.jsonl",
      1,
      "cursor",
    );
    expect(cursorShaped[0].speaker).toBe("Alex");
    expect(cursorShaped[0].role).toBe("user");
  });

  it("copies speaker onto every event split from that line", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-aaa",
        speaker: "Alex",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will remember the grain is bookings." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "config.json" } },
          ],
        },
      }),
      "sess-aaa",
      "/tmp/sess-aaa.jsonl",
      2,
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.speaker === "Alex")).toBe(true);
  });

  it("maps the JSONL timestamp as occurred_at, not copy time", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "user",
        sessionId: "sess-payload",
        timestamp: "2024-11-14T23:57:23.004Z",
        message: { role: "user", content: "The demo store prefers dark mode." },
      }),
      "sess-filename",
      "/tmp/sess-filename.jsonl",
      1,
    );
    expect(events).toHaveLength(1);
    expect(events[0].occurred_at).toBe("2024-11-14T23:57:23.004Z");
  });

  it("copies the line timestamp onto every event split from that line", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-aaa",
        timestamp: "2025-01-02T03:04:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will remember the dark mode preference." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "config.json" } },
          ],
        },
      }),
      "sess-aaa",
      "/tmp/sess-aaa.jsonl",
      2,
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.occurred_at === "2025-01-02T03:04:05.000Z")).toBe(
      true,
    );
  });

  it("ignores a JSONL timestamp that is not an ISO instant", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "user",
        sessionId: "sess-payload",
        timestamp: "this afternoon",
        message: { role: "user", content: "The demo store prefers dark mode." },
      }),
      "sess-filename",
      "/tmp/sess-filename.jsonl",
      1,
    );
    expect(events[0].occurred_at).toBeNull();
  });

  it("maps a tool_result nested in a user turn as role:tool, not role:user", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "user",
        sessionId: "sess-aaa",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: '{"theme":"dark"}',
            },
          ],
        },
      }),
      "sess-aaa",
      "/tmp/sess-aaa.jsonl",
      3,
    );
    expect(events).toHaveLength(1);
    expect(events[0].role).toBe("tool");
    expect(events[0].event_type).toBe("tool_result");
    expect(events[0].content).toContain("theme");
  });

  it("maps assistant text and tool_use, and skips thinking blocks", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-aaa",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private scratch" },
            { type: "text", text: "I will remember the dark mode preference." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "config.json" } },
          ],
        },
      }),
      "sess-aaa",
      "/tmp/sess-aaa.jsonl",
      2,
    );
    expect(events.map((e) => [e.role, e.event_type])).toEqual([
      ["assistant", "message"],
      ["assistant", "tool_call"],
    ]);
    expect(events[0].content).toContain("dark mode");
    expect(events[1].content).toContain("Read");
    expect(events.some((e) => e.content?.includes("private scratch"))).toBe(false);
  });

  it("skips isMeta user rows rather than labelling them as user turns", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "user",
        isMeta: true,
        sessionId: "sess-aaa",
        message: {
          role: "user",
          content: "<system-reminder>Do not mention this reminder.</system-reminder>",
        },
      }),
      "sess-aaa",
      "/tmp/sess-aaa.jsonl",
      4,
    );
    expect(events).toEqual([]);
  });

  it("skips system and UI snapshot types", () => {
    for (const type of [
      "system",
      "attachment",
      "last-prompt",
      "mode",
      "permission-mode",
      "ai-title",
      "agent-name",
      "file-history-snapshot",
      "file-history-delta",
    ]) {
      expect(
        mapTranscriptLine(
          JSON.stringify({ type, sessionId: "sess-aaa" }),
          "sess-aaa",
          "/tmp/sess-aaa.jsonl",
          1,
        ),
      ).toEqual([]);
    }
  });

  it("falls back to the filename session id when the payload has none", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "No session field on this line." },
      }),
      "sess-from-filename",
      "/tmp/sess-from-filename.jsonl",
      1,
    );
    expect(events[0].client_session_id).toBe("sess-from-filename");
  });

  it("still maps a role-only line with content on the row when message is absent", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        role: "user",
        content: "The demo store prefers dark mode.",
      }),
      "sess-export",
      "/tmp/sess-export.jsonl",
      1,
    );
    expect(events).toHaveLength(1);
    expect(events[0].content).toContain("dark mode");
  });

  it("maps a role-only line through message.content (Cursor Agent JSONL)", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        role: "user",
        message: {
          content: [
            { type: "text", text: "The demo store prefers dark mode." },
          ],
        },
      }),
      "sess-cursor",
      "/tmp/sess-cursor.jsonl",
      1,
      "cursor",
    );
    expect(events).toHaveLength(1);
    expect(events[0].role).toBe("user");
    expect(events[0].content).toContain("dark mode");
    expect(events[0].occurred_at).toBeNull();
    expect(events[0].metadata).toMatchObject({ source: "cursor" });
  });

  it("maps a role-only assistant line with text and tool_use", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "I will remember the dark mode preference." },
            { type: "tool_use", name: "Read", input: { path: "config.json" } },
          ],
        },
      }),
      "sess-cursor",
      "/tmp/sess-cursor.jsonl",
      2,
      "cursor",
    );
    expect(events.map((e) => [e.role, e.event_type])).toEqual([
      ["assistant", "message"],
      ["assistant", "tool_call"],
    ]);
    expect(events[1].content).toContain("Read");
  });

  it("unwraps <user_query> and drops the surrounding chrome", () => {
    const events = mapTranscriptLine(
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text:
                "<timestamp>Thursday, 1 January 2026, 12:00 PM</timestamp>\n" +
                "<user_query>\nRemember the demo store prefers dark mode.\n</user_query>",
            },
          ],
        },
      }),
      "sess-cursor",
      "/tmp/sess-cursor.jsonl",
      1,
      "cursor",
    );
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Remember the demo store prefers dark mode.");
    expect(events[0].content).not.toMatch(/timestamp/i);
  });

  it("skips turn_ended markers", () => {
    expect(
      mapTranscriptLine(
        JSON.stringify({ type: "turn_ended", status: "success" }),
        "sess-cursor",
        "/tmp/sess-cursor.jsonl",
        9,
        "cursor",
      ),
    ).toEqual([]);
  });

  it("skips empty, invalid JSON, and thinking-only assistant turns", () => {
    expect(mapTranscriptLine("", "s", "/tmp/s.jsonl", 1)).toEqual([]);
    expect(mapTranscriptLine("{not json", "s", "/tmp/s.jsonl", 1)).toEqual([]);
    expect(
      mapTranscriptLine(
        JSON.stringify({
          type: "assistant",
          sessionId: "s",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
        }),
        "s",
        "/tmp/s.jsonl",
        1,
      ),
    ).toEqual([]);
  });
});
