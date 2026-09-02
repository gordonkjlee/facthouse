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
  COPY_HEARTBEAT_DEBOUNCE_MS,
  createCopyHeartbeat,
  copySources,
} from "../../src/sources/copy.js";
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

async function events(db: Db) {
  return (await db
    .prepare(
      `SELECT role, event_type, content, client_session_id, metadata
         FROM session_events ORDER BY sequence ASC`,
    )
    .all()) as Array<{
    role: string;
    event_type: string;
    content: string;
    client_session_id: string;
    metadata: string | null;
  }>;
}

let root: string;
let db: Db;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "om-copy-"));
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
  rmSync(root, { recursive: true, force: true });
});

describe("copySources", () => {
  it("is a no-op when sources is empty", async () => {
    const result = await copySources(db, []);
    expect(result).toEqual({
      sources: 0,
      files: 0,
      events_inserted: 0,
      events_skipped: 0,
    });
    expect(await events(db)).toHaveLength(0);
  });

  it("copies a fixture JSONL into session_events and skips system and isMeta lines", async () => {
    const home = path.join(root, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    const file = path.join(home, "projects", group, "sess-aaa.jsonl");
    writeJsonl(file, fixtureLines("sess-aaa"));

    const result = await copySources(db, [{ kind: "claude-code", home }]);
    expect(result.sources).toBe(1);
    expect(result.files).toBe(1);
    expect(result.events_inserted).toBe(4);
    expect(result.events_skipped).toBe(2);

    const rows = await events(db);
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

    const session = (await db
      .prepare(`SELECT id, source_tool, project FROM sessions WHERE id = ?`)
      .get("sess-aaa")) as { id: string; source_tool: string; project: string };
    expect(session.source_tool).toBe("claude-code");
    expect(session.project).toBe(group);
  });

  it("records the JSONL timestamp as occurred_at, distinct from copy created_at", async () => {
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
    await copySources(db, [{ kind: "claude-code", home }]);
    const row = (await db
      .prepare(
        `SELECT occurred_at, created_at FROM session_events WHERE client_session_id = ?`,
      )
      .get("sess-time")) as { occurred_at: string | null; created_at: string };

    expect(row.occurred_at).toBe(said);
    expect(row.created_at >= before).toBe(true);
    expect(row.created_at).not.toBe(said);
  });

  it("a second copy of the same file is a no-op", async () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
      "sess-aaa.jsonl",
    );
    writeJsonl(file, fixtureLines("sess-aaa"));

    await copySources(db, [{ kind: "claude-code", home }]);
    const second = await copySources(db, [{ kind: "claude-code", home }]);
    expect(second.events_inserted).toBe(0);
    expect(await events(db)).toHaveLength(4);
  });

  it("a no-op copy still records project on a store that had none", async () => {
    const home = path.join(root, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    const file = path.join(home, "projects", group, "sess-aaa.jsonl");
    writeJsonl(file, fixtureLines("sess-aaa"));
    await copySources(db, [{ kind: "claude-code", home }]);
    await db.prepare(`DELETE FROM sessions`).run();
    const again = await copySources(db, [{ kind: "claude-code", home }]);
    expect(again.events_inserted).toBe(0);
    const row = (await db
      .prepare(`SELECT project FROM sessions WHERE id = ?`)
      .get("sess-aaa")) as { project: string };
    expect(row.project).toBe(group);
  });

  it("an appended line is the only insert on a third copy", async () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
      "sess-aaa.jsonl",
    );
    writeJsonl(file, fixtureLines("sess-aaa"));
    await copySources(db, [{ kind: "claude-code", home }]);
    await copySources(db, [{ kind: "claude-code", home }]);

    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-aaa",
        message: { role: "assistant", content: "Noted the extra preference." },
      }) + "\n",
    );

    const third = await copySources(db, [{ kind: "claude-code", home }]);
    expect(third.events_inserted).toBe(1);
    const rows = await events(db);
    expect(rows).toHaveLength(5);
    expect(rows[4].content).toContain("extra preference");
  });

  it("cwd filter excludes another project group, including sessions/ layout", async () => {
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

    const filtered = await copySources(db, [
      { kind: "claude-code", home, cwd: "C:\\dev\\app" },
    ]);
    expect(filtered.files).toBe(1);
    expect(filtered.events_inserted).toBe(4);
    expect((await events(db)).every((r) => r.client_session_id === "sess-keep")).toBe(true);

    // Without cwd, the nested sessions/ file is discovered too.
    const unfiltered = await copySources(db, [{ kind: "claude-code", home }]);
    expect(unfiltered.files).toBe(2);
    const projects = (await db
      .prepare(`SELECT id, project FROM sessions ORDER BY id`)
      .all()) as Array<{ id: string; project: string }>;
    expect(projects).toEqual([
      { id: "sess-keep", project: keep },
      { id: "sess-other", project: other },
    ]);
    expect(unfiltered.events_inserted).toBe(4);
    const ids = new Set((await events(db)).map((r) => r.client_session_id));
    expect(ids).toEqual(new Set(["sess-keep", "sess-other"]));
  });

  it("does not walk directories outside projects/", async () => {
    const home = path.join(root, "claude-home");
    writeJsonl(
      path.join(home, "tmp", "stray.jsonl"),
      fixtureLines("stray"),
    );
    writeJsonl(
      path.join(home, "projects", encodeProjectDir("/tmp/app"), "real.jsonl"),
      fixtureLines("real"),
    );

    const result = await copySources(db, [{ kind: "claude-code", home }]);
    expect(result.files).toBe(1);
    expect((await events(db)).every((r) => r.client_session_id === "real")).toBe(true);
  });

  it("rejects an unknown kind without inserting anything", async () => {
    await expect(
      copySources(db, [{ kind: "grok", home: path.join(root, "nope") }]),
    ).rejects.toThrow(/Unknown source kind "grok"/);
    expect(await events(db)).toHaveLength(0);
  });

  it("does not consume an incomplete last line, then inserts it once completed", async () => {
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

    const first = await copySources(db, [{ kind: "claude-code", home }]);
    expect(first.events_inserted).toBe(1);
    expect(await events(db)).toHaveLength(1);
    expect((await events(db))[0].content).toContain("Complete line one");

    writeFileSync(file, complete + incomplete + "\n", "utf-8");
    const second = await copySources(db, [{ kind: "claude-code", home }]);
    expect(second.events_inserted).toBe(1);
    const rows = await events(db);
    expect(rows).toHaveLength(2);
    expect(rows[1].content).toContain("Partial assistant line");
  });

  it("does not walk subagents/ nests under a session id", async () => {
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

    const result = await copySources(db, [{ kind: "claude-code", home }]);
    expect(result.files).toBe(1);
    expect((await events(db)).every((r) => r.client_session_id === "sess-parent")).toBe(true);
  });

  it("re-reads a rewrite that keeps the same header prefix", async () => {
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

    await copySources(db, [{ kind: "claude-code", home }]);
    expect(await events(db)).toHaveLength(2);

    writeFileSync(file, header + compactedBody, "utf-8");
    const again = await copySources(db, [{ kind: "claude-code", home }]);
    expect(again.events_inserted).toBe(2);
    const rows = await events(db);
    expect(rows).toHaveLength(4);
    expect(rows[3].content).toContain("Compacted summary");
  });

  it("re-reads a replaced file when the fingerprint no longer matches", async () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
      "sess-aaa.jsonl",
    );
    writeJsonl(file, fixtureLines("sess-aaa"));
    await copySources(db, [{ kind: "claude-code", home }]);

    writeJsonl(file, [
      JSON.stringify({
        type: "user",
        sessionId: "sess-aaa",
        message: { role: "user", content: "Replacement transcript starts here." },
      }),
    ]);

    const again = await copySources(db, [{ kind: "claude-code", home }]);
    expect(again.events_inserted).toBe(1);
    const rows = await events(db);
    expect(rows).toHaveLength(5);
    expect(rows[4].content).toContain("Replacement transcript");
  });
});

describe("createCopyHeartbeat", () => {
  it("never calls copy when sources is empty", async () => {
    let called = 0;
    const hb = createCopyHeartbeat({
      db,
      sources: [],
      copy: async () => {
        called += 1;
        throw new Error("must not copy on an empty sources list");
      },
    });
    const result = await hb.copyIfGrown();
    expect(called).toBe(0);
    expect(result.events_inserted).toBe(0);
    expect(result.sources).toBe(0);
  });

  it("inserts new lines on growth and is a no-op when watermarks match", async () => {
    const home = path.join(root, "claude-home");
    const file = path.join(
      home,
      "projects",
      encodeProjectDir("C:\\dev\\app"),
      "sess-hb.jsonl",
    );
    writeJsonl(file, fixtureLines("sess-hb"));
    const sources = [{ kind: "claude-code" as const, home }];
    let t = 10_000;
    const hb = createCopyHeartbeat({
      db,
      sources,
      now: () => t,
      debounceMs: COPY_HEARTBEAT_DEBOUNCE_MS,
    });

    const first = await hb.copyIfGrown();
    expect(first.events_inserted).toBe(4);
    t += COPY_HEARTBEAT_DEBOUNCE_MS;
    const second = await hb.copyIfGrown();
    expect(second.events_inserted).toBe(0);
    expect(await events(db)).toHaveLength(4);

    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-hb",
        message: { role: "assistant", content: "Noted the extra preference." },
      }) + "\n",
    );
    t += COPY_HEARTBEAT_DEBOUNCE_MS;
    const third = await hb.copyIfGrown();
    expect(third.events_inserted).toBe(1);
    expect(await events(db)).toHaveLength(5);
  });

  it("coalesces overlapping walks onto one in-flight copy", async () => {
    let walks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hb = createCopyHeartbeat({
      db,
      sources: [{ kind: "claude-code", home: "/tmp/unused" }],
      copy: async () => {
        walks += 1;
        await gate;
        return { sources: 1, files: 1, events_inserted: 2, events_skipped: 0 };
      },
    });
    const first = hb.copyIfGrown();
    const second = hb.copyIfGrown();
    expect(walks).toBe(1);
    release();
    expect(await first).toEqual(await second);
    expect((await first).events_inserted).toBe(2);
    expect(walks).toBe(1);
  });

  it("debounces from walk completion, not walk start", async () => {
    let t = 0;
    let walks = 0;
    const hb = createCopyHeartbeat({
      db,
      sources: [{ kind: "claude-code", home: "/tmp/unused" }],
      now: () => t,
      debounceMs: 2000,
      copy: async () => {
        walks += 1;
        t = 3000;
        return { sources: 1, files: 1, events_inserted: 0, events_skipped: 0 };
      },
    });
    await hb.copyIfGrown();
    t = 4000;
    await hb.copyIfGrown();
    expect(walks).toBe(1);
    t = 5000;
    await hb.copyIfGrown();
    expect(walks).toBe(2);
  });

  it("debounces two walks inside the window into one", async () => {
    let walks = 0;
    let t = 0;
    const hb = createCopyHeartbeat({
      db,
      sources: [{ kind: "claude-code", home: "/tmp/unused" }],
      now: () => t,
      debounceMs: 2000,
      copy: async () => {
        walks += 1;
        return { sources: 1, files: 1, events_inserted: 0, events_skipped: 0 };
      },
    });
    await hb.copyIfGrown();
    t = 500;
    await hb.copyIfGrown();
    expect(walks).toBe(1);
    t = 2000;
    await hb.copyIfGrown();
    expect(walks).toBe(2);
  });
});
