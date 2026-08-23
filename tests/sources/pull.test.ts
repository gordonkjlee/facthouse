import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
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
import { encodeProjectDir } from "../../src/sources/resolve.js";

/**
 * Synthetic Claude Code transcript — not real user data.
 * One user line, one assistant line with text + tool_use, one tool_result,
 * plus a system line the adapter must skip.
 */
function fixtureLines(sessionId: string): string[] {
  return [
    JSON.stringify({
      type: "user",
      sessionId,
      message: { role: "user", content: "Remember the demo store prefers dark mode." },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will remember the dark mode preference." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "config.json" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      sessionId,
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
    JSON.stringify({
      type: "system",
      subtype: "init",
      sessionId,
    }),
  ];
}

function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.map((l) => l + "\n").join(""), "utf-8");
}

function events(db: Db) {
  return db
    .prepare(
      `SELECT role, event_type, content, client_session_id, metadata
         FROM session_events ORDER BY sequence ASC`,
    )
    .all() as Array<{
    role: string;
    event_type: string;
    content: string;
    client_session_id: string;
    metadata: string | null;
  }>;
}

let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "om-pull-"));
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(root, { recursive: true, force: true });
});

describe("pullSources", () => {
  it("is a no-op when sources is empty", () => {
    const result = pullSources(db, []);
    expect(result).toEqual({
      sources: 0,
      files: 0,
      events_inserted: 0,
      events_skipped: 0,
    });
    expect(events(db)).toHaveLength(0);
  });

  it("ingests a fixture JSONL into session_events and skips system lines", () => {
    const home = path.join(root, "claude-home");
    const group = encodeProjectDir("C:\\dev\\investment");
    const file = path.join(home, "projects", group, "sess-aaa.jsonl");
    writeJsonl(file, fixtureLines("sess-aaa"));

    const result = pullSources(db, [{ kind: "claude-code", home }]);
    expect(result.sources).toBe(1);
    expect(result.files).toBe(1);
    expect(result.events_inserted).toBe(4);
    expect(result.events_skipped).toBe(1);

    const rows = events(db);
    expect(rows.map((r) => [r.role, r.event_type])).toEqual([
      ["user", "message"],
      ["assistant", "message"],
      ["assistant", "tool_call"],
      ["tool", "tool_result"],
    ]);
    expect(rows[0].content).toContain("dark mode");
    expect(rows[2].content).toContain("Read");
    expect(rows[3].content).toContain("theme");
    expect(rows.every((r) => r.client_session_id === "sess-aaa")).toBe(true);
    expect(JSON.parse(rows[0].metadata ?? "{}").source).toBe("claude-code");
  });

  it("a second pull of the same file is a no-op", () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\investment"),
      "sess-aaa.jsonl",
    );
    writeJsonl(file, fixtureLines("sess-aaa"));

    pullSources(db, [{ kind: "claude-code", home }]);
    const second = pullSources(db, [{ kind: "claude-code", home }]);
    expect(second.events_inserted).toBe(0);
    expect(events(db)).toHaveLength(4);
  });

  it("an appended line is the only insert on a third pull", () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\investment"),
      "sess-aaa.jsonl",
    );
    writeJsonl(file, fixtureLines("sess-aaa"));
    pullSources(db, [{ kind: "claude-code", home }]);
    pullSources(db, [{ kind: "claude-code", home }]);

    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-aaa",
        message: { role: "assistant", content: "Noted the extra preference." },
      }) + "\n",
    );

    const third = pullSources(db, [{ kind: "claude-code", home }]);
    expect(third.events_inserted).toBe(1);
    const rows = events(db);
    expect(rows).toHaveLength(5);
    expect(rows[4].content).toContain("extra preference");
  });

  it("cwd filter excludes another project group, including sessions/ layout", () => {
    const home = path.join(root, "claude-home");
    const keep = encodeProjectDir("C:\\dev\\investment");
    const other = encodeProjectDir("C:\\dev\\other");
    writeJsonl(
      path.join(home, "projects", keep, "sess-keep.jsonl"),
      fixtureLines("sess-keep"),
    );
    writeJsonl(
      path.join(home, "projects", other, "sessions", "sess-other.jsonl"),
      fixtureLines("sess-other"),
    );

    const filtered = pullSources(db, [
      { kind: "claude-code", home, cwd: "C:\\dev\\investment" },
    ]);
    expect(filtered.files).toBe(1);
    expect(filtered.events_inserted).toBe(4);
    expect(events(db).every((r) => r.client_session_id === "sess-keep")).toBe(true);

    // Without cwd, the nested sessions/ file is discovered too.
    const unfiltered = pullSources(db, [{ kind: "claude-code", home }]);
    expect(unfiltered.files).toBe(2);
    expect(unfiltered.events_inserted).toBe(4);
    const ids = new Set(events(db).map((r) => r.client_session_id));
    expect(ids).toEqual(new Set(["sess-keep", "sess-other"]));
  });

  it("does not walk directories outside projects/", () => {
    const home = path.join(root, "claude-home");
    writeJsonl(
      path.join(home, "tmp", "stray.jsonl"),
      fixtureLines("stray"),
    );
    writeJsonl(
      path.join(home, "projects", encodeProjectDir("/tmp/app"), "real.jsonl"),
      fixtureLines("real"),
    );

    const result = pullSources(db, [{ kind: "claude-code", home }]);
    expect(result.files).toBe(1);
    expect(events(db).every((r) => r.client_session_id === "real")).toBe(true);
  });

  it("rejects an unknown kind without inserting anything", () => {
    expect(() =>
      pullSources(db, [{ kind: "cursor", home: path.join(root, "nope") }]),
    ).toThrow(/Unknown source kind "cursor"/);
    expect(events(db)).toHaveLength(0);
  });

  it("re-reads a replaced file when the fingerprint no longer matches", () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\investment"),
      "sess-aaa.jsonl",
    );
    writeJsonl(file, fixtureLines("sess-aaa"));
    pullSources(db, [{ kind: "claude-code", home }]);

    writeJsonl(file, [
      JSON.stringify({
        type: "user",
        sessionId: "sess-aaa",
        message: { role: "user", content: "Replacement transcript starts here." },
      }),
    ]);

    const again = pullSources(db, [{ kind: "claude-code", home }]);
    expect(again.events_inserted).toBe(1);
    const rows = events(db);
    expect(rows).toHaveLength(5);
    expect(rows[4].content).toContain("Replacement transcript");
  });
});
