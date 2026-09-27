import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase, type Db } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { copySources } from "../../src/sources/copy.js";
import {
  discoverGrokFiles,
  grokGroupsForCwd,
  mapGrokLine,
} from "../../src/sources/grok.js";
import { encodeGrokSessionDir, resolveSources } from "../../src/sources/resolve.js";
import { captureFactDescription } from "../../src/tools/capture-fact-description.js";
import { SOURCE_MTIME_META } from "../../src/intelligence/line-time.js";

/**
 * Synthetic Grok Build `chat_history.jsonl` — not real user data. Mirrors the
 * on-disk shape: typed lines, user content as text blocks, assistant content
 * a string with `tool_calls` whose `arguments` is a JSON string, no
 * timestamps, reasoning carrying `encrypted_content`.
 */
const CIPHERTEXT = "gAAAAABsyntheticciphertextnotspeech";

function grokLines(): string[] {
  return [
    JSON.stringify({ type: "system", content: "You are Grok Build." }),
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<system-reminder>be brief</system-reminder>" }],
      synthetic_reason: "system_reminder",
    }),
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "Remember Alex prefers dark mode." }],
      prompt_index: 0,
    }),
    JSON.stringify({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Thinking about the preference." }],
      encrypted_content: CIPHERTEXT,
      status: "completed",
    }),
    JSON.stringify({
      type: "assistant",
      content: "I will note the dark mode preference.",
      tool_calls: [{ id: "call_1", name: "read_file", arguments: '{"path":"config.json"}' }],
      model_id: "grok-build",
    }),
    JSON.stringify({ type: "tool_result", tool_call_id: "call_1", content: '{"theme":"dark"}' }),
    JSON.stringify({
      type: "backend_tool_call",
      kind: { tool_type: "web_search", action: { type: "search", query: "dark mode" }, id: "ws_1", status: "completed" },
    }),
    JSON.stringify({ type: "not_a_line_type", content: "ignored" }),
  ];
}

function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.map((l) => l + "\n").join(""), "utf-8");
}

const CWD = "C:\\dev\\app";
const GROUP = encodeGrokSessionDir(CWD);

function session(home: string, group: string, id: string): string {
  return path.join(home, "sessions", group, id);
}

async function events(db: Db) {
  return (await db
    .prepare(
      `SELECT role, event_type, content, content_type, client_session_id, occurred_at, metadata
         FROM session_events ORDER BY sequence ASC`,
    )
    .all()) as Array<{
    role: string;
    event_type: string;
    content: string;
    content_type: string;
    client_session_id: string;
    occurred_at: string | null;
    metadata: string | null;
  }>;
}

let root: string;
let home: string;
let db: Db;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "om-grok-"));
  home = path.join(root, "Users", "alex", ".grok");
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
  rmSync(root, { recursive: true, force: true });
});

describe("encodeGrokSessionDir", () => {
  it("URL-encodes the cwd the way Grok names its group", () => {
    expect(encodeGrokSessionDir("C:\\dev\\app")).toBe("C%3A%5Cdev%5Capp");
    expect(encodeGrokSessionDir("C:\\dev\\app\\")).toBe("C%3A%5Cdev%5Capp");
    expect(encodeGrokSessionDir("/home/alex/app")).toBe("%2Fhome%2Falex%2Fapp");
    expect(encodeGrokSessionDir("C:\\dev\\my-app")).toBe("C%3A%5Cdev%5Cmy-app");
  });
});

describe("mapGrokLine", () => {
  const map = (line: unknown) => mapGrokLine(JSON.stringify(line), "s1", "/f", 1);

  it("maps a typed user line and skips a harness-injected one", () => {
    const [user] = map({ type: "user", content: [{ type: "text", text: "Hi there" }] });
    expect(user).toMatchObject({ role: "user", event_type: "message", content: "Hi there" });
    for (const reason of ["system_reminder", "project_instructions", "compaction_meta", "task_completed"]) {
      expect(map({ type: "user", content: [{ type: "text", text: "x" }], synthetic_reason: reason })).toEqual([]);
    }
  });

  it("keeps text blocks of a user line and drops images", () => {
    const [user] = map({
      type: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ],
    });
    expect(user!.content).toBe("Look at this");
    expect(map({ type: "user", content: [{ type: "image", url: "data:," }] })).toEqual([]);
  });

  it("maps assistant text and each tool call in the Claude Code shape", () => {
    const out = map({
      type: "assistant",
      content: "Reading it.",
      tool_calls: [
        { id: "c1", name: "read_file", arguments: '{"path":"a.md"}' },
        { id: "c2", name: "run", arguments: "not json" },
        { id: "c3" },
      ],
    });
    expect(out.map((e) => [e.role, e.event_type])).toEqual([
      ["assistant", "message"],
      ["assistant", "tool_call"],
      ["assistant", "tool_call"],
    ]);
    expect(JSON.parse(out[1]!.content!)).toEqual({ name: "read_file", input: { path: "a.md" }, id: "c1" });
    expect(JSON.parse(out[2]!.content!)).toEqual({ name: "run", input: "not json", id: "c2" });
  });

  it("maps an assistant line that is only tool calls", () => {
    const out = map({ type: "assistant", content: "", tool_calls: [{ id: "c1", name: "ls", arguments: "{}" }] });
    expect(out.map((e) => e.event_type)).toEqual(["tool_call"]);
  });

  it("maps a tool result as role tool", () => {
    const [res] = map({ type: "tool_result", tool_call_id: "c1", content: "[1,2]" });
    expect(res).toMatchObject({ role: "tool", event_type: "tool_result", content_type: "json" });
    expect(map({ type: "tool_result", tool_call_id: "c1", content: "" })).toEqual([]);
  });

  it("skips reasoning, system, backend tool calls, unknown types and junk", () => {
    expect(map({ type: "reasoning", summary: [], encrypted_content: CIPHERTEXT })).toEqual([]);
    expect(map({ type: "system", content: "You are Grok." })).toEqual([]);
    expect(map({ type: "backend_tool_call", kind: { tool_type: "web_search" } })).toEqual([]);
    expect(map({ type: "surprise", content: "x" })).toEqual([]);
    expect(map({ role: "user", content: "no type" })).toEqual([]);
    expect(mapGrokLine("{not json", "s1", "/f", 1)).toEqual([]);
    expect(mapGrokLine("[1,2]", "s1", "/f", 1)).toEqual([]);
    expect(mapGrokLine("   ", "s1", "/f", 1)).toEqual([]);
  });

  it("uses a line timestamp when present and never invents one", () => {
    const [a] = map({ type: "user", content: "hi", timestamp: "2026-01-01T12:00:00Z" });
    expect(a!.occurred_at).toBe("2026-01-01T12:00:00.000Z");
    const [b] = map({ type: "user", content: "hi" });
    expect(b!.occurred_at).toBeNull();
    const [c] = map({ type: "user", content: "hi", timestamp: "yesterday" });
    expect(c!.occurred_at).toBeNull();
  });
});

describe("discoverGrokFiles", () => {
  it("finds chat_history.jsonl only, under sessions/<group>/<id>/", () => {
    const s = session(home, GROUP, "sess-a");
    writeJsonl(path.join(s, "chat_history.jsonl"), grokLines());
    writeJsonl(path.join(s, "updates.jsonl"), [JSON.stringify({ type: "user_message_chunk" })]);
    writeJsonl(path.join(s, "events.jsonl"), [JSON.stringify({ type: "x" })]);
    writeJsonl(path.join(home, "memory-v2", "notes.jsonl"), [JSON.stringify({ type: "user", content: "x" })]);
    writeJsonl(path.join(home, "logs", "unified.jsonl"), [JSON.stringify({ type: "user", content: "x" })]);
    writeJsonl(path.join(home, "sessions", GROUP, "prompt_history.jsonl"), [JSON.stringify({ type: "user", content: "x" })]);

    const [src] = resolveSources([{ kind: "grok", home, cwd: CWD }]);
    expect(discoverGrokFiles(src!)).toEqual([path.join(s, "chat_history.jsonl")]);
  });

  it("returns nothing when home has no sessions directory", () => {
    const [src] = resolveSources([{ kind: "grok", home: path.join(root, "missing") }]);
    expect(discoverGrokFiles(src!)).toEqual([]);
  });

  it("restricts to the cwd's group", () => {
    const mine = session(home, GROUP, "mine");
    const other = session(home, encodeGrokSessionDir("C:\\dev\\other"), "theirs");
    writeJsonl(path.join(mine, "chat_history.jsonl"), grokLines());
    writeJsonl(path.join(other, "chat_history.jsonl"), grokLines());

    const [scoped] = resolveSources([{ kind: "grok", home, cwd: CWD }]);
    expect(discoverGrokFiles(scoped!)).toEqual([path.join(mine, "chat_history.jsonl")]);
    const [bare] = resolveSources([{ kind: "grok", home }]);
    expect(discoverGrokFiles(bare!)).toHaveLength(2);
  });

  it("finds Grok's group from a forward-slash or lower-case drive cwd", () => {
    writeJsonl(path.join(session(home, GROUP, "a"), "chat_history.jsonl"), grokLines());
    const root = path.join(home, "sessions");
    for (const cwd of ["C:/dev/app", "c:\\dev\\app", "c:/dev/app/"]) {
      expect(grokGroupsForCwd(root, cwd)).toEqual([path.join(root, GROUP)]);
    }
  });

  it("honours a literal group name and never joins an absolute cwd", () => {
    const sessionsRoot = path.join(home, "sessions");
    writeJsonl(path.join(session(home, GROUP, "a"), "chat_history.jsonl"), grokLines());
    expect(grokGroupsForCwd(sessionsRoot, GROUP)).toEqual([path.join(sessionsRoot, GROUP)]);
    // A real directory outside the home must not become a group.
    const outside = path.join(root, "outside");
    writeJsonl(path.join(outside, "x", "chat_history.jsonl"), grokLines());
    expect(grokGroupsForCwd(sessionsRoot, outside)).toEqual([]);
    expect(grokGroupsForCwd(sessionsRoot, "..")).toEqual([]);
  });

  it("matches a long cwd through the group's .cwd file", () => {
    const longCwd = "C:\\dev\\" + "deep\\".repeat(60) + "app";
    expect(Buffer.byteLength(encodeGrokSessionDir(longCwd))).toBeGreaterThan(255);
    const group = path.join(home, "sessions", "app-1a2b3c4d");
    writeFileSync(path.join((mkdirSync(group, { recursive: true }), group), ".cwd"), longCwd + "\n");
    writeJsonl(path.join(group, "s1", "chat_history.jsonl"), grokLines());
    const decoy = path.join(home, "sessions", "app-99999999");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(path.join(decoy, ".cwd"), "C:\\dev\\other\n");
    writeJsonl(path.join(decoy, "s2", "chat_history.jsonl"), grokLines());

    const [src] = resolveSources([{ kind: "grok", home, cwd: longCwd }]);
    expect(discoverGrokFiles(src!)).toEqual([path.join(group, "s1", "chat_history.jsonl")]);
  });

  it("skips sub-agent sessions, including one that ran in another group", () => {
    const parent = session(home, GROUP, "parent");
    const child = session(home, GROUP, "child-here");
    const farChild = session(home, encodeGrokSessionDir("C:\\dev\\app\\pkg"), "child-far");
    const farParentChild = session(home, GROUP, "child-of-far-parent");
    const farParent = session(home, encodeGrokSessionDir("C:\\dev\\elsewhere"), "far-parent");
    for (const s of [parent, child, farChild, farParentChild, farParent]) {
      writeJsonl(path.join(s, "chat_history.jsonl"), grokLines());
    }
    for (const [p, c] of [[parent, "child-here"], [parent, "child-far"], [farParent, "child-of-far-parent"]] as const) {
      mkdirSync(path.join(p, "subagents", c), { recursive: true });
      writeFileSync(path.join(p, "subagents", c, "meta.json"), "{}");
    }

    const [src] = resolveSources([{ kind: "grok", home, cwd: CWD }]);
    expect(discoverGrokFiles(src!)).toEqual([path.join(parent, "chat_history.jsonl")]);
  });
});

describe("copySources with kind grok", () => {
  it("copies speech into D with grok provenance and no ciphertext", async () => {
    const s = session(home, GROUP, "sess-a");
    writeJsonl(path.join(s, "chat_history.jsonl"), grokLines());

    const result = await copySources(db, [{ kind: "grok", home, cwd: CWD }]);
    expect(result).toMatchObject({ sources: 1, files: 1, events_inserted: 4, events_skipped: 5 });

    const rows = await events(db);
    expect(rows.map((r) => [r.role, r.event_type])).toEqual([
      ["user", "message"],
      ["assistant", "message"],
      ["assistant", "tool_call"],
      ["tool", "tool_result"],
    ]);
    expect(rows[0]!.content).toBe("Remember Alex prefers dark mode.");
    expect(rows.every((r) => r.client_session_id === "sess-a")).toBe(true);
    expect(rows.every((r) => r.occurred_at === null)).toBe(true);
    for (const r of rows) {
      const meta = JSON.parse(r.metadata!);
      expect(meta.source).toBe("grok");
      expect(typeof meta[SOURCE_MTIME_META]).toBe("string");
      expect(r.content).not.toContain(CIPHERTEXT);
      expect(r.content).not.toContain("system-reminder");
    }

    const sessions = (await db.prepare("SELECT id, source_tool, project FROM sessions").all()) as Array<{
      id: string;
      source_tool: string;
      project: string;
    }>;
    expect(sessions).toEqual([{ id: "sess-a", source_tool: "grok", project: GROUP }]);
  });

  it("resumes from the watermark: unchanged copies 0, an appended line copies 1", async () => {
    const file = path.join(session(home, GROUP, "sess-a"), "chat_history.jsonl");
    writeJsonl(file, grokLines());
    const sources = [{ kind: "grok", home, cwd: CWD }];

    await copySources(db, sources);
    expect((await copySources(db, sources)).events_inserted).toBe(0);

    appendFileSync(file, JSON.stringify({ type: "user", content: [{ type: "text", text: "Also Robin." }] }) + "\n");
    expect((await copySources(db, sources)).events_inserted).toBe(1);
    expect((await events(db)).at(-1)!.content).toBe("Also Robin.");
  });

  it("keeps two sessions in one group apart", async () => {
    writeJsonl(path.join(session(home, GROUP, "one"), "chat_history.jsonl"), grokLines());
    writeJsonl(path.join(session(home, GROUP, "two"), "chat_history.jsonl"), grokLines());
    await copySources(db, [{ kind: "grok", home, cwd: CWD }]);
    const ids = new Set((await events(db)).map((r) => r.client_session_id));
    expect(ids).toEqual(new Set(["one", "two"]));
  });

  it("is a successful no-op when the Grok home does not exist", async () => {
    const result = await copySources(db, [{ kind: "grok", home: path.join(root, "nope"), cwd: CWD }]);
    expect(result).toEqual({ sources: 1, files: 0, events_inserted: 0, events_skipped: 0 });
  });

  it("copies Claude Code and Grok into one store, and capture_fact stays a correction", async () => {
    const claudeHome = path.join(root, "Users", "alex", ".claude");
    writeJsonl(path.join(claudeHome, "projects", "C--dev-app", "claude-1.jsonl"), [
      JSON.stringify({
        type: "user",
        sessionId: "claude-1",
        timestamp: "2026-01-01T12:00:00Z",
        message: { role: "user", content: "Robin is on the platform team." },
      }),
    ]);
    writeJsonl(path.join(session(home, GROUP, "grok-1"), "chat_history.jsonl"), grokLines());
    const sources = [
      { kind: "claude-code", home: claudeHome, cwd: CWD },
      { kind: "grok", home, cwd: CWD },
    ];

    const result = await copySources(db, sources);
    expect(result.sources).toBe(2);
    expect(result.files).toBe(2);
    const bySession = new Set((await events(db)).map((r) => r.client_session_id));
    expect(bySession).toEqual(new Set(["claude-1", "grok-1"]));

    const text = captureFactDescription(sources);
    expect(text).toBe(captureFactDescription([{ kind: "claude-code", home: claudeHome, cwd: CWD }]));
    expect(text).toMatch(/when you need to correct/i);
    expect(text).not.toMatch(/proactively/i);
  });
});
