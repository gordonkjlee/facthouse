import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase, type Db } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { copySources } from "../../src/sources/copy.js";
import { grokGroupNames, mapGrokLine } from "../../src/sources/grok.js";
import { encodeGrokProjectDir } from "../../src/sources/resolve.js";
import { CAPTURE_SOURCE_KINDS } from "../../src/types/config.js";

/**
 * Synthetic Grok Build chat_history.jsonl — not real user data.
 * One user line, one assistant line with text + tool_calls, one tool_result,
 * plus reasoning / system / backend_tool_call / hook / compaction lines
 * the adapter must skip.
 */
function fixtureLines(): string[] {
  return [
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-21T15:04:05.000Z",
      content: [
        {
          type: "text",
          text: "<user_query>\nRemember the demo store prefers dark mode.\n</user_query>",
        },
      ],
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-21T15:04:06.000Z",
      content: "I will remember the dark mode preference.",
      tool_calls: [
        {
          id: "call_1",
          name: "read_file",
          arguments: JSON.stringify({ path: "config.json" }),
        },
      ],
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call_1",
      content: '{"theme":"dark"}',
    }),
    JSON.stringify({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "ENC_BLOB_xyz",
      summary: [{ type: "summary_text", text: "thinking about dark mode" }],
    }),
    JSON.stringify({
      type: "system",
      content: "You are Grok. Synthetic system line, not a user turn.",
    }),
    JSON.stringify({
      type: "backend_tool_call",
      kind: { tool_type: "web_search", id: "ws_1" },
    }),
    JSON.stringify({
      type: "user",
      synthetic_reason: "compaction_meta",
      content: [{ type: "text", text: "Compacted file contents, not speech." }],
    }),
    JSON.stringify({
      type: "user",
      synthetic_reason: "stop_hook_feedback",
      content: [{ type: "text", text: "Hook said keep going." }],
    }),
    "{not json",
  ];
}

function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.map((l) => l + "\n").join(""), "utf-8");
}

function sessionDir(home: string, group: string, sessionId: string): string {
  return path.join(home, "sessions", group, sessionId);
}

async function events(db: Db) {
  return (await db
    .prepare(
      `SELECT role, event_type, content, client_session_id, occurred_at, metadata
         FROM session_events ORDER BY sequence ASC`,
    )
    .all()) as Array<{
    role: string;
    event_type: string;
    content: string;
    client_session_id: string;
    occurred_at: string | null;
    metadata: string | null;
  }>;
}

let root: string;
let db: Db;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "om-grok-"));
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
  rmSync(root, { recursive: true, force: true });
});

describe("grokGroupNames", () => {
  it("URL-encodes a Windows cwd and does not keep the absolute path as a child name", () => {
    expect(grokGroupNames("C:\\dev\\app")).toEqual(["C%3A%5Cdev%5Capp"]);
    expect(grokGroupNames("C:\\dev\\app")).not.toContain("C:\\dev\\app");
  });
});

describe("mapGrokLine", () => {
  it("drops a reasoning line that carries encrypted_content", () => {
    const eventsOut = mapGrokLine(
      JSON.stringify({
        type: "reasoning",
        encrypted_content: "ENC_BLOB_xyz",
        summary: [{ type: "summary_text", text: "secret thought" }],
      }),
      "sess-1",
      "/tmp/chat_history.jsonl",
      1,
    );
    expect(eventsOut).toEqual([]);
    expect(JSON.stringify(eventsOut)).not.toContain("ENC_BLOB_xyz");
  });
});

describe("copySources grok", () => {
  it("copies chat_history.jsonl into session_events with source_tool grok", async () => {
    const home = path.join(root, "grok-home");
    const group = encodeGrokProjectDir("C:\\dev\\app");
    const sessionId = "sess-grok-1";
    const dir = sessionDir(home, group, sessionId);
    writeJsonl(path.join(dir, "chat_history.jsonl"), fixtureLines());
    writeJsonl(path.join(dir, "updates.jsonl"), [
      JSON.stringify({
        type: "user_message_chunk",
        content: "This updates.jsonl line must not be copied.",
      }),
    ]);
    writeFileSync(path.join(dir, "system_prompt.txt"), "system prompt, not D");
    mkdirSync(path.join(home, "memory-v2"), { recursive: true });
    writeJsonl(path.join(home, "memory-v2", "chat_history.jsonl"), fixtureLines());
    mkdirSync(path.join(home, "logs"), { recursive: true });
    writeJsonl(path.join(home, "logs", "unified.jsonl"), fixtureLines());

    const result = await copySources(db, [{ kind: "grok", home, cwd: "C:\\dev\\app" }]);
    expect(result.sources).toBe(1);
    expect(result.files).toBe(1);
    expect(result.events_inserted).toBe(4);
    expect(result.events_skipped).toBe(6);

    const rows = await events(db);
    expect(rows.map((r) => [r.role, r.event_type])).toEqual([
      ["user", "message"],
      ["assistant", "message"],
      ["assistant", "tool_call"],
      ["tool", "tool_result"],
    ]);
    expect(rows[0].content).toBe("Remember the demo store prefers dark mode.");
    expect(rows[0].occurred_at).toBe("2026-09-21T15:04:05.000Z");
    expect(rows[1].content).toBe("I will remember the dark mode preference.");
    expect(JSON.parse(rows[2].content)).toEqual({
      name: "read_file",
      input: { path: "config.json" },
      id: "call_1",
    });
    expect(rows[3].content).toContain("theme");
    expect(rows.every((r) => r.client_session_id === sessionId)).toBe(true);
    for (const row of rows) {
      const meta = JSON.parse(row.metadata ?? "{}") as { source_tool?: string; source?: string };
      expect(meta.source_tool).toBe("grok");
      expect(meta.source).toBe("grok");
      expect(row.content).not.toContain("ENC_BLOB_xyz");
      expect(row.content).not.toContain("updates.jsonl line");
      expect(row.content).not.toContain("Compacted file");
      expect(row.content).not.toContain("Hook said");
    }

    const session = (await db
      .prepare(`SELECT id, source_tool, project FROM sessions WHERE id = ?`)
      .get(sessionId)) as { id: string; source_tool: string; project: string };
    expect(session.source_tool).toBe("grok");
    expect(session.project).toBe(group);

    const blob = JSON.stringify(await events(db));
    expect(blob).not.toContain("ENC_BLOB_xyz");
  });

  it("cwd restricts discovery to the encoded group and does not join a Windows path", async () => {
    const home = path.join(root, "grok-home");
    const keep = encodeGrokProjectDir("C:\\dev\\app");
    const other = encodeGrokProjectDir("C:\\dev\\other");
    writeJsonl(
      path.join(sessionDir(home, keep, "sess-keep"), "chat_history.jsonl"),
      fixtureLines(),
    );
    writeJsonl(
      path.join(sessionDir(home, other, "sess-other"), "chat_history.jsonl"),
      fixtureLines(),
    );
    // A directory whose name is the raw Windows cwd must not be the join target.
    writeJsonl(
      path.join(sessionDir(home, "C:\\dev\\app", "sess-trap"), "chat_history.jsonl"),
      fixtureLines(),
    );

    const filtered = await copySources(db, [
      { kind: "grok", home, cwd: "C:\\dev\\app" },
    ]);
    expect(filtered.files).toBe(1);
    expect((await events(db)).every((r) => r.client_session_id === "sess-keep")).toBe(true);
  });

  it("honours a .cwd file when the group name is a slug instead of the encoding", async () => {
    const home = path.join(root, "grok-home");
    const cwd = "C:\\dev\\" + "nested\\".repeat(40) + "app";
    expect(Buffer.byteLength(encodeGrokProjectDir(cwd), "utf8")).toBeGreaterThan(255);
    const slug = "app-deadbeef";
    const dir = sessionDir(home, slug, "sess-long");
    writeJsonl(path.join(dir, "chat_history.jsonl"), [
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "Long-path workspace still copies." }],
      }),
    ]);
    writeFileSync(path.join(home, "sessions", slug, ".cwd"), cwd + "\n");
    writeJsonl(
      path.join(sessionDir(home, "other-slug", "sess-decoy"), "chat_history.jsonl"),
      [JSON.stringify({ type: "user", content: "Decoy group." })],
    );
    writeFileSync(path.join(home, "sessions", "other-slug", ".cwd"), "C:\\dev\\elsewhere\n");

    const result = await copySources(db, [{ kind: "grok", home, cwd }]);
    expect(result.files).toBe(1);
    expect(result.events_inserted).toBe(1);
    const rows = await events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("Long-path workspace");
    expect(rows[0].client_session_id).toBe("sess-long");
    const session = (await db
      .prepare(`SELECT project, source_tool FROM sessions WHERE id = ?`)
      .get("sess-long")) as { project: string; source_tool: string };
    expect(session.project).toBe(slug);
    expect(session.source_tool).toBe("grok");
  });

  it("does not discover a child session named by summary.json or subagents/", async () => {
    const home = path.join(root, "grok-home");
    const group = encodeGrokProjectDir("C:\\dev\\app");
    writeJsonl(
      path.join(sessionDir(home, group, "sess-parent"), "chat_history.jsonl"),
      [JSON.stringify({ type: "user", content: [{ type: "text", text: "Parent said this." }] })],
    );
    writeFileSync(
      path.join(sessionDir(home, group, "sess-parent"), "summary.json"),
      JSON.stringify({ info: { id: "sess-parent" } }),
    );
    mkdirSync(path.join(sessionDir(home, group, "sess-parent"), "subagents", "sess-child"), {
      recursive: true,
    });
    writeFileSync(
      path.join(sessionDir(home, group, "sess-parent"), "subagents", "sess-child", "meta.json"),
      JSON.stringify({ session_id: "sess-child" }),
    );
    writeJsonl(
      path.join(sessionDir(home, group, "sess-child"), "chat_history.jsonl"),
      [JSON.stringify({ type: "user", content: [{ type: "text", text: "Child chatter." }] })],
    );
    writeFileSync(
      path.join(sessionDir(home, group, "sess-child"), "summary.json"),
      JSON.stringify({ parent_session_id: "sess-parent", session_kind: "subagent" }),
    );
    writeJsonl(
      path.join(sessionDir(home, group, "sess-fork"), "chat_history.jsonl"),
      [JSON.stringify({ type: "user", content: [{ type: "text", text: "Fork chatter." }] })],
    );
    writeFileSync(
      path.join(sessionDir(home, group, "sess-fork"), "summary.json"),
      JSON.stringify({ parent_session_id: "sess-parent" }),
    );

    const result = await copySources(db, [{ kind: "grok", home, cwd: "C:\\dev\\app" }]);
    expect(result.files).toBe(1);
    const rows = await events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].client_session_id).toBe("sess-parent");
    expect(rows[0].content).toContain("Parent said this");
  });

  it("a second copy of an unchanged file inserts 0 and an appended user line inserts 1", async () => {
    const home = path.join(root, "grok-home");
    const group = encodeGrokProjectDir("C:\\dev\\app");
    const file = path.join(sessionDir(home, group, "sess-wm"), "chat_history.jsonl");
    writeJsonl(file, [
      JSON.stringify({ type: "user", content: [{ type: "text", text: "First line." }] }),
    ]);
    const sources = [{ kind: "grok" as const, home, cwd: "C:\\dev\\app" }];
    await copySources(db, sources);
    const second = await copySources(db, sources);
    expect(second.events_inserted).toBe(0);
    expect(await events(db)).toHaveLength(1);

    appendFileSync(
      file,
      JSON.stringify({ type: "user", content: [{ type: "text", text: "Appended line." }] }) + "\n",
    );
    const third = await copySources(db, sources);
    expect(third.events_inserted).toBe(1);
    const rows = await events(db);
    expect(rows).toHaveLength(2);
    expect(rows[1].content).toContain("Appended line");
  });

  it("a missing home copies zero files and does not throw", async () => {
    const result = await copySources(db, [
      { kind: "grok", home: path.join(root, "no-such-grok"), cwd: "C:\\dev\\app" },
    ]);
    expect(result).toEqual({
      sources: 1,
      files: 0,
      events_inserted: 0,
      events_skipped: 0,
    });
    expect(await events(db)).toHaveLength(0);
  });

  it("leaves occurred_at null when the line has no timestamp", async () => {
    const home = path.join(root, "grok-home");
    const group = encodeGrokProjectDir("C:\\dev\\app");
    writeJsonl(path.join(sessionDir(home, group, "sess-notime"), "chat_history.jsonl"), [
      JSON.stringify({ type: "assistant", content: "No clock on this line." }),
    ]);
    await copySources(db, [{ kind: "grok", home, cwd: "C:\\dev\\app" }]);
    const row = (await events(db))[0];
    expect(row.occurred_at).toBeNull();
    expect(row.role).toBe("assistant");
  });
});

describe("README copy kinds", () => {
  const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");

  it("names every shipped kind and does not say Grok has no adapter", () => {
    for (const kind of CAPTURE_SOURCE_KINDS) {
      expect(readme).toContain(`"${kind}"`);
    }
    expect(readme).toContain("kind: \"grok\"");
    expect(readme).not.toMatch(/Grok has no transcript adapter/);
    expect(readme).not.toMatch(/Grok and Codex are later adapters/);
    expect(readme).toMatch(/Name a `grok` source on the same store/);
    expect(readme).toMatch(/do not also install record hooks/i);
  });
});
