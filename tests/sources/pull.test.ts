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
import {
  SESSION_START_FLUSH_MAX_INSERTED,
  pullSources,
  shouldFlushAfterSessionStartPull,
  shouldTickAfterCliPull,
} from "../../src/sources/pull.js";
import { encodeProjectDir } from "../../src/sources/resolve.js";

/**
 * Synthetic Claude Code transcript — not real user data.
 * One user line, one assistant line with text + tool_use, one tool_result,
 * plus a system line and an isMeta user line the adapter must skip.
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
    JSON.stringify({
      type: "user",
      isMeta: true,
      sessionId,
      message: {
        role: "user",
        content: "<system-reminder>Synthetic meta line, not a user turn.</system-reminder>",
      },
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

  it("ingests a fixture JSONL into session_events and skips system and isMeta lines", () => {
    const home = path.join(root, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    const file = path.join(home, "projects", group, "sess-aaa.jsonl");
    writeJsonl(file, fixtureLines("sess-aaa"));

    const result = pullSources(db, [{ kind: "claude-code", home }]);
    expect(result.sources).toBe(1);
    expect(result.files).toBe(1);
    expect(result.events_inserted).toBe(4);
    expect(result.events_skipped).toBe(2);

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

    const session = db
      .prepare(`SELECT id, source_tool, project FROM sessions WHERE id = ?`)
      .get("sess-aaa") as { id: string; source_tool: string; project: string };
    expect(session.source_tool).toBe("claude-code");
    expect(session.project).toBe(group);
  });

  it("records the JSONL timestamp as occurred_at, distinct from ingest created_at", () => {
    const home = path.join(root, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    const file = path.join(home, "projects", group, "sess-time.jsonl");
    const said = "2024-11-14T23:57:23.004Z";
    writeJsonl(file, [
      JSON.stringify({
        type: "user",
        sessionId: "sess-time",
        timestamp: said,
        message: { role: "user", content: "Remember the demo store prefers dark mode." },
      }),
    ]);

    const before = new Date().toISOString();
    pullSources(db, [{ kind: "claude-code", home }]);
    const row = db
      .prepare(
        `SELECT occurred_at, created_at FROM session_events WHERE client_session_id = ?`,
      )
      .get("sess-time") as { occurred_at: string | null; created_at: string };

    expect(row.occurred_at).toBe(said);
    expect(row.created_at >= before).toBe(true);
    expect(row.created_at).not.toBe(said);
  });

  it("a second pull of the same file is a no-op", () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
      "sess-aaa.jsonl",
    );
    writeJsonl(file, fixtureLines("sess-aaa"));

    pullSources(db, [{ kind: "claude-code", home }]);
    const second = pullSources(db, [{ kind: "claude-code", home }]);
    expect(second.events_inserted).toBe(0);
    expect(events(db)).toHaveLength(4);
  });

  it("a no-op pull still records project on a store that had none", () => {
    const home = path.join(root, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    const file = path.join(home, "projects", group, "sess-aaa.jsonl");
    writeJsonl(file, fixtureLines("sess-aaa"));
    pullSources(db, [{ kind: "claude-code", home }]);
    db.prepare(`DELETE FROM sessions`).run();
    const again = pullSources(db, [{ kind: "claude-code", home }]);
    expect(again.events_inserted).toBe(0);
    const row = db
      .prepare(`SELECT project FROM sessions WHERE id = ?`)
      .get("sess-aaa") as { project: string };
    expect(row.project).toBe(group);
  });

  it("an appended line is the only insert on a third pull", () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
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
    const keep = encodeProjectDir("C:\\dev\\app");
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
      { kind: "claude-code", home, cwd: "C:\\dev\\app" },
    ]);
    expect(filtered.files).toBe(1);
    expect(filtered.events_inserted).toBe(4);
    expect(events(db).every((r) => r.client_session_id === "sess-keep")).toBe(true);

    // Without cwd, the nested sessions/ file is discovered too.
    const unfiltered = pullSources(db, [{ kind: "claude-code", home }]);
    expect(unfiltered.files).toBe(2);
    const projects = db
      .prepare(`SELECT id, project FROM sessions ORDER BY id`)
      .all() as Array<{ id: string; project: string }>;
    expect(projects).toEqual([
      { id: "sess-keep", project: keep },
      { id: "sess-other", project: other },
    ]);
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
      pullSources(db, [{ kind: "grok", home: path.join(root, "nope") }]),
    ).toThrow(/Unknown source kind "grok"/);
    expect(events(db)).toHaveLength(0);
  });

  it("does not consume an incomplete last line, then inserts it once completed", () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
      "sess-aaa.jsonl",
    );
    const complete =
      JSON.stringify({
        type: "user",
        sessionId: "sess-aaa",
        message: { role: "user", content: "Complete line one." },
      }) + "\n";
    const incomplete = JSON.stringify({
      type: "assistant",
      sessionId: "sess-aaa",
      message: { role: "assistant", content: "Partial assistant line that is still being written." },
    });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, complete + incomplete, "utf-8");
    // Shorter than the 256-byte fingerprint window — an append used to
    // change the prefix hash and look like a rewrite.
    expect(Buffer.byteLength(complete + incomplete, "utf-8")).toBeLessThan(256);

    const first = pullSources(db, [{ kind: "claude-code", home }]);
    expect(first.events_inserted).toBe(1);
    expect(events(db)).toHaveLength(1);
    expect(events(db)[0].content).toContain("Complete line one");

    writeFileSync(file, complete + incomplete + "\n", "utf-8");
    const second = pullSources(db, [{ kind: "claude-code", home }]);
    expect(second.events_inserted).toBe(1);
    const rows = events(db);
    expect(rows).toHaveLength(2);
    expect(rows[1].content).toContain("Partial assistant line");
  });

  it("does not walk subagents/ nests under a session id", () => {
    const home = path.join(root, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    writeJsonl(
      path.join(home, "projects", group, "sess-parent.jsonl"),
      fixtureLines("sess-parent"),
    );
    writeJsonl(
      path.join(home, "projects", group, "sess-parent", "subagents", "agent-aaa.jsonl"),
      fixtureLines("agent-aaa"),
    );

    const result = pullSources(db, [{ kind: "claude-code", home }]);
    expect(result.files).toBe(1);
    expect(events(db).every((r) => r.client_session_id === "sess-parent")).toBe(true);
  });

  it("re-reads a rewrite that keeps the same header prefix", () => {
    // Compaction often leaves the opening user line intact and replaces the
    // body. A prefix-only fingerprint would miss that and skip the new lines.
    const header =
      JSON.stringify({
        type: "user",
        sessionId: "sess-aaa",
        message: {
          role: "user",
          content: "Stable header line. " + "x".repeat(280),
        },
      }) + "\n";
    const originalBody =
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-aaa",
        message: { role: "assistant", content: "Original body before compaction." },
      }) + "\n";
    const compactedBody =
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-aaa",
        message: { role: "assistant", content: "Compacted summary of the session." },
      }) + "\n";

    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
      "sess-aaa.jsonl",
    );
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, header + originalBody, "utf-8");
    expect(Buffer.byteLength(header, "utf-8")).toBeGreaterThan(256);

    pullSources(db, [{ kind: "claude-code", home }]);
    expect(events(db)).toHaveLength(2);

    writeFileSync(file, header + compactedBody, "utf-8");
    const again = pullSources(db, [{ kind: "claude-code", home }]);
    expect(again.events_inserted).toBe(2);
    const rows = events(db);
    expect(rows).toHaveLength(4);
    expect(rows[3].content).toContain("Compacted summary");
  });

  it("re-reads a replaced file when the fingerprint no longer matches", () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
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

describe("shouldTickAfterCliPull", () => {
  it("does not tick when nothing new was inserted", () => {
    expect(shouldTickAfterCliPull(0)).toBe(false);
  });

  it("ticks a handful of new lines so a Stop pull can graduate", () => {
    expect(shouldTickAfterCliPull(1)).toBe(true);
    expect(shouldTickAfterCliPull(SESSION_START_FLUSH_MAX_INSERTED)).toBe(true);
  });

  it("does not tick a large first-run backfill", () => {
    expect(shouldTickAfterCliPull(SESSION_START_FLUSH_MAX_INSERTED + 1)).toBe(false);
    expect(shouldTickAfterCliPull(5000)).toBe(false);
  });
});

describe("shouldFlushAfterSessionStartPull", () => {
  it("flushes leftovers when the pull inserted nothing", () => {
    expect(shouldFlushAfterSessionStartPull(0)).toBe(true);
  });

  it("flushes a handful of new lines from a normal session", () => {
    expect(shouldFlushAfterSessionStartPull(1)).toBe(true);
    expect(shouldFlushAfterSessionStartPull(SESSION_START_FLUSH_MAX_INSERTED)).toBe(
      true,
    );
  });

  it("skips flush after a large first-run backfill", () => {
    expect(shouldFlushAfterSessionStartPull(SESSION_START_FLUSH_MAX_INSERTED + 1)).toBe(
      false,
    );
    expect(shouldFlushAfterSessionStartPull(5000)).toBe(false);
  });
});
