import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase, type Db } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { pullSources } from "../../src/sources/pull.js";
import { cursorGroupNames } from "../../src/sources/cursor.js";
import { encodeCursorProjectDir } from "../../src/sources/resolve.js";

/**
 * Synthetic Cursor Agent JSONL — not real user data.
 * Mirrors the on-disk shape: role + message.content blocks, no type,
 * no timestamp, user_query wrapper, tool_use without id, turn_ended.
 */
function cursorLines(): string[] {
  return [
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
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "I will remember the dark mode preference." },
          { type: "tool_use", name: "Read", input: { path: "config.json" } },
        ],
      },
    }),
    JSON.stringify({ type: "turn_ended", status: "success" }),
  ];
}

function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.map((l) => l + "\n").join(""), "utf-8");
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
  root = mkdtempSync(path.join(tmpdir(), "om-cursor-"));
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
  rmSync(root, { recursive: true, force: true });
});

describe("cursorGroupNames", () => {
  it("encodes a Windows cwd and does not keep the absolute path as a child name", () => {
    expect(cursorGroupNames("C:\\dev\\app")).toEqual(["c-dev-app"]);
  });

  it("honours an already-encoded group or opaque numeric id", () => {
    expect(cursorGroupNames("c-dev-app")).toEqual(["c-dev-app"]);
    expect(cursorGroupNames("1783503355025")).toEqual(["1783503355025"]);
  });
});

describe("pullSources cursor", () => {
  it("ingests nested agent-transcripts JSONL and skips turn_ended", async () => {
    const home = path.join(root, "cursor-home");
    const group = encodeCursorProjectDir("C:\\dev\\app");
    const session = "11111111-1111-1111-1111-111111111111";
    writeJsonl(
      path.join(home, "projects", group, "agent-transcripts", session, `${session}.jsonl`),
      cursorLines(),
    );

    const result = await pullSources(db, [{ kind: "cursor", home }]);
    expect(result.sources).toBe(1);
    expect(result.files).toBe(1);
    expect(result.events_inserted).toBe(3);
    expect(result.events_skipped).toBe(1);

    const rows = await events(db);
    expect(rows.map((r) => [r.role, r.event_type])).toEqual([
      ["user", "message"],
      ["assistant", "message"],
      ["assistant", "tool_call"],
    ]);
    expect(rows[0].content).toBe("Remember the demo store prefers dark mode.");
    expect(rows[0].occurred_at).toBeNull();
    expect(JSON.parse(rows[0].metadata ?? "{}").source).toBe("cursor");
    expect(rows.every((r) => r.client_session_id === session)).toBe(true);

    const sessionRow = (await db
      .prepare(`SELECT id, source_tool, project FROM sessions WHERE id = ?`)
      .get(session)) as { id: string; source_tool: string; project: string };
    expect(sessionRow.source_tool).toBe("cursor");
    expect(sessionRow.project).toBe(group);
  });

  it("discovers a flat agent-transcripts JSONL as well as the nested layout", async () => {
    const home = path.join(root, "cursor-home");
    const group = encodeCursorProjectDir("C:\\dev\\app");
    writeJsonl(
      path.join(home, "projects", group, "agent-transcripts", "sess-flat.jsonl"),
      cursorLines(),
    );

    const result = await pullSources(db, [{ kind: "cursor", home }]);
    expect(result.files).toBe(1);
    expect(result.events_inserted).toBe(3);
    expect((await events(db))[0].client_session_id).toBe("sess-flat");
  });

  it("cwd filter uses Cursor encoding, not Claude Code encoding", async () => {
    const home = path.join(root, "cursor-home");
    const keep = encodeCursorProjectDir("C:\\dev\\app");
    const other = encodeCursorProjectDir("C:\\dev\\other");
    writeJsonl(
      path.join(home, "projects", keep, "agent-transcripts", "sess-keep.jsonl"),
      cursorLines(),
    );
    writeJsonl(
      path.join(home, "projects", other, "agent-transcripts", "sess-other.jsonl"),
      cursorLines(),
    );
    // Claude Code's group name must not be treated as a Cursor hit.
    writeJsonl(
      path.join(home, "projects", "C--dev-app", "agent-transcripts", "sess-cc.jsonl"),
      cursorLines(),
    );

    const filtered = await pullSources(db, [
      { kind: "cursor", home, cwd: "C:\\dev\\app" },
    ]);
    expect(filtered.files).toBe(1);
    expect((await events(db)).every((r) => r.client_session_id === "sess-keep")).toBe(true);
  });

  it("does not walk Composer SQLite, chats/, .txt, or files outside agent-transcripts", async () => {
    const home = path.join(root, "cursor-home");
    const group = encodeCursorProjectDir("C:\\dev\\app");
    writeJsonl(
      path.join(home, "projects", group, "agent-transcripts", "sess-real.jsonl"),
      cursorLines(),
    );
    writeFileSync(path.join(home, "projects", group, "store.db"), "not-sqlite");
    mkdirSync(path.join(home, "chats", "abc"), { recursive: true });
    writeJsonl(path.join(home, "chats", "abc", "store-export.jsonl"), cursorLines());
    writeFileSync(
      path.join(home, "projects", group, "agent-transcripts", "legacy.txt"),
      "user:\nRemember the demo store prefers dark mode.\n",
    );
    writeJsonl(
      path.join(
        home,
        "projects",
        group,
        "agent-transcripts",
        "sess-real",
        "subagents",
        "agent-aaa.jsonl",
      ),
      cursorLines(),
    );

    const result = await pullSources(db, [{ kind: "cursor", home }]);
    expect(result.files).toBe(1);
    expect((await events(db)).every((r) => r.client_session_id === "sess-real")).toBe(true);
  });

  it("a second pull of the same file is a no-op", async () => {
    const home = path.join(root, "cursor-home");
    const group = encodeCursorProjectDir("C:\\dev\\app");
    writeJsonl(
      path.join(home, "projects", group, "agent-transcripts", "sess-aaa.jsonl"),
      cursorLines(),
    );
    await pullSources(db, [{ kind: "cursor", home }]);
    const second = await pullSources(db, [{ kind: "cursor", home }]);
    expect(second.events_inserted).toBe(0);
    expect(await events(db)).toHaveLength(3);
  });
});
