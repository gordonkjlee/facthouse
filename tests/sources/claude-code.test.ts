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
