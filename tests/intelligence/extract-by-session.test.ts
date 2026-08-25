/**
 * Two concurrent conversations pulled in one process must stay separate
 * through extract, working memory, rolling summary, and provenance.
 *
 * Synthetic fixtures only — not real transcripts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "../../src/db/connection.js";
import type { SessionEvent, SessionFact, Fact } from "../../src/types/data.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent, createSession } = await import("../../src/db/sessions.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
const { pullSources } = await import("../../src/sources/pull.js");
const { encodeProjectDir } = await import("../../src/sources/resolve.js");
const { PERSONAL_VOCABULARY } = await import("../fixtures/vocabulary.js");

let db: Db;
let tmpRoot: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
  tmpRoot = mkdtempSync(path.join(tmpdir(), "om-extract-session-"));
});

afterEach(() => {
  closeDatabase(db);
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface ExtractCall {
  events: string[];
  workingMemory: string[];
  sessionSummary: string | null;
}

function userLine(sessionId: string, content: string): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    message: { role: "user", content },
  });
}

function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.map((l) => l + "\n").join(""), "utf-8");
}

function recording() {
  const calls: ExtractCall[] = [];
  const summaries: Array<{ sessionIds: string[]; prior: string | null }> = [];
  const provider = {
    ...createHeuristicProvider(PERSONAL_VOCABULARY),
    async extractFactsFromEvents(
      events: SessionEvent[],
      workingMemory: SessionEvent[],
      sessionSummary: string | null,
    ) {
      calls.push({
        events: events.map((e) => e.content ?? ""),
        workingMemory: workingMemory.map((e) => e.content ?? ""),
        sessionSummary: sessionSummary ?? null,
      });
      return {
        facts: events
          .filter((e) => e.content)
          .map((e) => ({
            content: e.content as string,
            domain_hint: "preferences",
          })),
        degraded: false,
      };
    },
    async summarise(
      facts: SessionFact[],
      _graduated: Fact[],
      prior: string | null,
    ) {
      summaries.push({
        sessionIds: [...new Set(facts.map((f) => f.session_id))],
        prior: prior ?? null,
      });
      const id = facts[0]?.session_id ?? "unknown";
      return {
        summary: `rolling summary of ${id}`,
        openThreads: [],
      };
    },
  };
  return { provider, calls, summaries };
}

function factRows() {
  return db
    .prepare(
      `SELECT sf.session_id AS session_id, sf.content AS content
         FROM session_facts sf
        ORDER BY sf.created_at ASC`,
    )
    .all() as Array<{ session_id: string; content: string }>;
}

function provenanceSessions(factContent: string) {
  return db
    .prepare(
      `SELECT e.client_session_id AS client_session_id,
              e.mcp_session_id AS mcp_session_id,
              s.extraction_type AS type
         FROM session_fact_sources s
         JOIN session_events e ON e.id = s.event_id
         JOIN session_facts sf ON sf.id = s.session_fact_id
        WHERE sf.content = ?`,
    )
    .all(factContent) as Array<{
    client_session_id: string | null;
    mcp_session_id: string | null;
    type: string;
  }>;
}

describe("extraction groups by conversation, not by pull batch", () => {
  it("two JSONL files in one pull stay separate through extract and provenance", async () => {
    const home = path.join(tmpRoot, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    const factA = "Alex prefers oat milk at Acme.";
    const factB = "Alex is allergic to shellfish.";
    writeJsonl(path.join(home, "projects", group, "sess-aaa.jsonl"), [
      userLine("sess-aaa", factA),
    ]);
    writeJsonl(path.join(home, "projects", group, "sess-bbb.jsonl"), [
      userLine("sess-bbb", factB),
    ]);

    const pulled = pullSources(db, [{ kind: "claude-code", home }]);
    expect(pulled.events_inserted).toBe(2);

    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });

    expect(calls).toHaveLength(2);
    const byFirstEvent = new Map(calls.map((c) => [c.events[0], c]));
    expect(byFirstEvent.get(factA)?.events).toEqual([factA]);
    expect(byFirstEvent.get(factB)?.events).toEqual([factB]);
    // First extract: working memory is empty (nothing pre-watermark). The
    // disjoint `events` arrays are what prove the batch was not concatenated.

    const facts = factRows();
    expect(facts).toEqual(
      expect.arrayContaining([
        { session_id: "sess-aaa", content: factA },
        { session_id: "sess-bbb", content: factB },
      ]),
    );

    const srcA = provenanceSessions(factA);
    expect(srcA.length).toBeGreaterThan(0);
    expect(srcA.every((s) => s.client_session_id === "sess-aaa")).toBe(true);
    const srcB = provenanceSessions(factB);
    expect(srcB.length).toBeGreaterThan(0);
    expect(srcB.every((s) => s.client_session_id === "sess-bbb")).toBe(true);
  });

  it("a later mixed pull keeps the other conversation out of working memory", async () => {
    // The first extract has no pre-watermark rows, so a WM assertion there
    // cannot fail. Seed each conversation, advance the watermark, then pull
    // a new line in both files in one process.
    const home = path.join(tmpRoot, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    const fileA = path.join(home, "projects", group, "sess-aaa.jsonl");
    const fileB = path.join(home, "projects", group, "sess-bbb.jsonl");
    const priorA = "Alex previously mentioned oat milk at Acme.";
    const priorB = "Alex previously mentioned a shellfish allergy.";
    writeJsonl(fileA, [userLine("sess-aaa", priorA)]);
    writeJsonl(fileB, [userLine("sess-bbb", priorB)]);
    pullSources(db, [{ kind: "claude-code", home }]);
    await consolidate(db, recording().provider as never, {
      extraction: { enabled: true } as never,
    });

    const nextA = "Alex prefers oat milk at Acme.";
    const nextB = "Alex is allergic to shellfish.";
    appendFileSync(fileA, userLine("sess-aaa", nextA) + "\n");
    appendFileSync(fileB, userLine("sess-bbb", nextB) + "\n");
    const secondPull = pullSources(db, [{ kind: "claude-code", home }]);
    expect(secondPull.events_inserted).toBe(2);

    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });

    expect(calls).toHaveLength(2);
    const byNext = new Map(calls.map((c) => [c.events[0], c]));
    expect(byNext.get(nextA)?.events).toEqual([nextA]);
    expect(byNext.get(nextB)?.events).toEqual([nextB]);
    expect(byNext.get(nextA)?.workingMemory.join(" ")).toContain("oat milk");
    expect(byNext.get(nextA)?.workingMemory.join(" ")).not.toContain(
      "shellfish",
    );
    expect(byNext.get(nextB)?.workingMemory.join(" ")).toContain("shellfish");
    expect(byNext.get(nextB)?.workingMemory.join(" ")).not.toContain("oat milk");
  });

  it("contextual provenance does not spray onto the other conversation", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex mentioned oat milk at Acme this morning.",
    });
    insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex mentioned a shellfish allergy this morning.",
    });

    const paraphrasing = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents(events: SessionEvent[]) {
        return {
          facts: events.map((e) => ({
            content: (e.content ?? "").includes("oat")
              ? "The user drinks oat milk."
              : "The user has a shellfish allergy.",
            domain_hint: "preferences",
          })),
          degraded: false,
        };
      },
    };

    await consolidate(db, paraphrasing as never, {
      extraction: { enabled: true } as never,
    });

    const oat = provenanceSessions("The user drinks oat milk.");
    expect(oat.length).toBeGreaterThan(0);
    expect(oat.every((s) => s.client_session_id === "sess-aaa")).toBe(true);
    expect(oat.every((s) => s.type === "contextual")).toBe(true);

    const allergy = provenanceSessions("The user has a shellfish allergy.");
    expect(allergy.length).toBeGreaterThan(0);
    expect(allergy.every((s) => s.client_session_id === "sess-bbb")).toBe(true);
  });

  it("same timestamps on the two files still stay separate", async () => {
    const home = path.join(tmpRoot, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    const fileA = path.join(home, "projects", group, "sess-aaa.jsonl");
    const fileB = path.join(home, "projects", group, "sess-bbb.jsonl");
    writeJsonl(fileA, [userLine("sess-aaa", "Alex works at Acme.")]);
    writeJsonl(fileB, [userLine("sess-bbb", "Alex lives in Edinburgh.")]);
    const stamp = new Date("2026-01-15T12:00:00.000Z");
    utimesSync(fileA, stamp, stamp);
    utimesSync(fileB, stamp, stamp);

    pullSources(db, [{ kind: "claude-code", home }]);
    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });

    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.events.length > 1)).toBe(false);
  });

  it("writes a rolling summary per conversation, not one mixed narrative", async () => {
    const home = path.join(tmpRoot, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    writeJsonl(path.join(home, "projects", group, "sess-aaa.jsonl"), [
      userLine("sess-aaa", "Alex prefers oat milk at Acme."),
    ]);
    writeJsonl(path.join(home, "projects", group, "sess-bbb.jsonl"), [
      userLine("sess-bbb", "Alex is allergic to shellfish."),
    ]);
    pullSources(db, [{ kind: "claude-code", home }]);

    const { provider, summaries } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });

    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.sessionIds)).toEqual(
      expect.arrayContaining([["sess-aaa"], ["sess-bbb"]]),
    );

    const satellites = db
      .prepare(
        `SELECT session_id, summary, facts_graduated, last_event_sequence
           FROM consolidations
          WHERE session_id IS NOT NULL AND summary IS NOT NULL
          ORDER BY session_id`,
      )
      .all() as Array<{
      session_id: string;
      summary: string;
      facts_graduated: number;
      last_event_sequence: number;
    }>;
    expect(satellites).toHaveLength(2);
    expect(satellites.every((r) => r.facts_graduated === 0)).toBe(true);
    expect(satellites.map((r) => r.session_id).sort()).toEqual([
      "sess-aaa",
      "sess-bbb",
    ]);
    const watermark = db
      .prepare(`SELECT MAX(last_event_sequence) AS seq FROM consolidations`)
      .get() as { seq: number };
    expect(watermark.seq).toBeGreaterThan(0);
    expect(satellites.every((r) => r.last_event_sequence === watermark.seq)).toBe(
      true,
    );

    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex also prefers dark roast.",
    });
    const second = recording();
    await consolidate(db, second.provider as never, {
      extraction: { enabled: true } as never,
    });
    const aaa = second.calls.find((c) =>
      c.events.some((e) => e.includes("dark roast")),
    );
    expect(aaa).toBeDefined();
    expect(aaa!.sessionSummary).toBe("rolling summary of sess-aaa");
    expect(aaa!.sessionSummary).not.toContain("sess-bbb");
  });

  it("does not attach pulled conversations to log-event's most-recent session", async () => {
    const home = path.join(tmpRoot, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    writeJsonl(path.join(home, "projects", group, "sess-aaa.jsonl"), [
      userLine("sess-aaa", "Alex prefers oat milk at Acme."),
    ]);
    writeJsonl(path.join(home, "projects", group, "sess-bbb.jsonl"), [
      userLine("sess-bbb", "Alex is allergic to shellfish."),
    ]);
    pullSources(db, [{ kind: "claude-code", home }]);

    // What `log-event` without --session-id does: create/reuse a sessions row
    // and store it as mcp_session_id. Pull must not inherit that id.
    const mcp = createSession(db, { source_tool: "cli", project: null }).id;
    insertEvent(db, {
      mcp_session_id: mcp,
      event_type: "message",
      role: "user",
      content: "a manual note with no session id",
    });

    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });

    expect(calls).toHaveLength(3);
    const facts = factRows();
    expect(facts).toEqual(
      expect.arrayContaining([
        {
          session_id: "sess-aaa",
          content: "Alex prefers oat milk at Acme.",
        },
        {
          session_id: "sess-bbb",
          content: "Alex is allergic to shellfish.",
        },
        { session_id: mcp, content: "a manual note with no session id" },
      ]),
    );
    expect(
      facts
        .filter((f) => f.content.includes("oat milk") || f.content.includes("shellfish"))
        .every((f) => f.session_id !== mcp),
    ).toBe(true);
  });

  it("does not persist a successful group when another group in the batch is degraded", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });

    let calls = 0;
    const flaky = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents(events: SessionEvent[]) {
        calls += 1;
        if (calls === 2) {
          return {
            facts: [
              {
                content: "this fact must not land; the extractor did not finish",
                domain_hint: "preferences",
              },
            ],
            degraded: true,
          };
        }
        return {
          facts: events
            .filter((e) => e.content)
            .map((e) => ({
              content: e.content as string,
              domain_hint: "preferences",
            })),
          degraded: false,
        };
      },
    };

    const first = await consolidate(db, flaky as never, {
      extraction: { enabled: true } as never,
    });
    expect(first.extractionDegraded).toBe(true);
    expect(factRows()).toEqual([]);
    const watermark = db
      .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
      .get() as { seq: number };
    expect(watermark.seq).toBe(0);

    const { provider } = recording();
    const second = await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(second.extractionDegraded).toBe(false);
    expect(factRows().map((f) => f.session_id).sort()).toEqual([
      "sess-aaa",
      "sess-bbb",
    ]);
  });
});

describe("working memory is kind-branched", () => {
  it("includes dual-id MCP rows in the client window and excludes mcp-only collisions", async () => {
    insertEvent(db, {
      mcp_session_id: "mcp-x",
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "dual-id prior from the same Claude chat",
    });
    insertEvent(db, {
      mcp_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "mcp-only collision with the client id string",
    });
    const watermarkSeq = db
      .prepare(`SELECT MAX(sequence) AS seq FROM session_events`)
      .get() as { seq: number };
    db.prepare(
      `INSERT INTO consolidations
         (id, session_id, facts_in, facts_graduated, facts_rejected,
          entities_created, entities_linked, supersessions,
          summary, open_threads, last_event_sequence, created_at)
       VALUES ('wm-mark', NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, datetime('now'))`,
    ).run(watermarkSeq.seq);

    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });

    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });

    const aaa = calls.find((c) =>
      c.events.some((e) => e.includes("oat milk")),
    );
    expect(aaa).toBeDefined();
    expect(aaa!.workingMemory.join(" ")).toContain("dual-id prior");
    expect(aaa!.workingMemory.join(" ")).not.toContain("mcp-only collision");
  });
});
