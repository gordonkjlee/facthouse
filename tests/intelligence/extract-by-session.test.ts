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
const {
  extractWatermark,
  conversationExtractThrough,
  setConversationExtractThrough,
} = await import("../../src/db/extract-watermarks.js");
const { pruneEvents } = await import("../../src/db/prune.js");
const { copySources } = await import("../../src/sources/copy.js");
const { encodeProjectDir } = await import("../../src/sources/resolve.js");
const { PERSONAL_VOCABULARY } = await import("../fixtures/vocabulary.js");

let db: Db;
let tmpRoot: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
  tmpRoot = mkdtempSync(path.join(tmpdir(), "om-extract-session-"));
});

afterEach(async () => {
  await closeDatabase(db);
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
      _integrated: Fact[],
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

async function factRows() {
  return (await db
    .prepare(
      `SELECT sf.session_id AS session_id, sf.content AS content
         FROM session_facts sf
        ORDER BY sf.created_at ASC`,
    )
    .all()) as Array<{ session_id: string; content: string }>;
}

async function provenanceSessions(factContent: string) {
  return (await db
    .prepare(
      `SELECT e.client_session_id AS client_session_id,
              e.mcp_session_id AS mcp_session_id,
              s.extraction_type AS type
         FROM session_fact_sources s
         JOIN session_events e ON e.id = s.event_id
         JOIN session_facts sf ON sf.id = s.session_fact_id
        WHERE sf.content = ?`,
    )
    .all(factContent)) as Array<{
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

    const pulled = await copySources(db, [{ kind: "claude-code", home }]);
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

    const facts = await factRows();
    expect(facts).toEqual(
      expect.arrayContaining([
        { session_id: "sess-aaa", content: factA },
        { session_id: "sess-bbb", content: factB },
      ]),
    );

    const srcA = await provenanceSessions(factA);
    expect(srcA.length).toBeGreaterThan(0);
    expect(srcA.every((s) => s.client_session_id === "sess-aaa")).toBe(true);
    const srcB = await provenanceSessions(factB);
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
    await copySources(db, [{ kind: "claude-code", home }]);
    await consolidate(db, recording().provider as never, {
      extraction: { enabled: true } as never,
    });

    const nextA = "Alex prefers oat milk at Acme.";
    const nextB = "Alex is allergic to shellfish.";
    appendFileSync(fileA, userLine("sess-aaa", nextA) + "\n");
    appendFileSync(fileB, userLine("sess-bbb", nextB) + "\n");
    const secondPull = await copySources(db, [{ kind: "claude-code", home }]);
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

  it("a rewritten extract does not invent contextual provenance on either conversation", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex mentioned oat milk at Acme this morning.",
    });
    await insertEvent(db, {
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

    const oat = await provenanceSessions("The user drinks oat milk.");
    expect(oat).toEqual([]);

    const allergy = await provenanceSessions("The user has a shellfish allergy.");
    expect(allergy).toEqual([]);
  });

  it("a rewritten extract does not claim every event in the conversation", async () => {
    for (let i = 0; i < 8; i++) {
      await insertEvent(db, {
        client_session_id: "sess-long",
        event_type: "message",
        role: "user",
        content: `tool dump ${i} of the schema listing`,
      });
    }
    const paraphrasing = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents() {
        return {
          facts: [
            {
              content:
                "stg_orders is missing booked_at at the grain of the orders mart.",
              domain_hint: "pipeline",
            },
          ],
          degraded: false,
        };
      },
    };
    await consolidate(db, paraphrasing as never, {
      extraction: { enabled: true } as never,
    });
    const links = await provenanceSessions(
      "stg_orders is missing booked_at at the grain of the orders mart.",
    );
    expect(links).toEqual([]);
  });

  it("a verbatim extract still keeps one primary event", async () => {
    const said = "Bookings are the grain of the orders mart at Acme.";
    await insertEvent(db, {
      client_session_id: "sess-verbatim",
      event_type: "message",
      role: "user",
      content: said,
    });
    await insertEvent(db, {
      client_session_id: "sess-verbatim",
      event_type: "tool_result",
      role: "tool",
      content: "CREATE TABLE stg_orders (id int);",
    });
    const echoing = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents() {
        return {
          facts: [{ content: said, domain_hint: "pipeline" }],
          degraded: false,
        };
      },
    };
    await consolidate(db, echoing as never, {
      extraction: { enabled: true } as never,
    });
    const links = await provenanceSessions(said);
    expect(links).toHaveLength(1);
    expect(links[0]?.type).toBe("primary");
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

    await copySources(db, [{ kind: "claude-code", home }]);
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
    await copySources(db, [{ kind: "claude-code", home }]);

    const { provider, summaries } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });

    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.sessionIds)).toEqual(
      expect.arrayContaining([["sess-aaa"], ["sess-bbb"]]),
    );

    const satellites = (await db
      .prepare(
        `SELECT session_id, summary, facts_integrated, last_event_sequence
           FROM consolidations
          WHERE session_id IS NOT NULL AND summary IS NOT NULL
          ORDER BY session_id`,
      )
      .all()) as Array<{
      session_id: string;
      summary: string;
      facts_integrated: number;
      last_event_sequence: number;
    }>;
    expect(satellites).toHaveLength(2);
    expect(satellites.every((r) => r.facts_integrated === 0)).toBe(true);
    expect(satellites.map((r) => r.session_id).sort()).toEqual([
      "sess-aaa",
      "sess-bbb",
    ]);
    const watermark = (await db
      .prepare(`SELECT MAX(last_event_sequence) AS seq FROM consolidations`)
      .get()) as { seq: number };
    expect(watermark.seq).toBeGreaterThan(0);
    expect(satellites.every((r) => r.last_event_sequence === watermark.seq)).toBe(
      true,
    );

    await insertEvent(db, {
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

  it("does not attach pulled conversations to record's most-recent session", async () => {
    const home = path.join(tmpRoot, "claude-home");
    const group = encodeProjectDir("C:\\dev\\app");
    writeJsonl(path.join(home, "projects", group, "sess-aaa.jsonl"), [
      userLine("sess-aaa", "Alex prefers oat milk at Acme."),
    ]);
    writeJsonl(path.join(home, "projects", group, "sess-bbb.jsonl"), [
      userLine("sess-bbb", "Alex is allergic to shellfish."),
    ]);
    await copySources(db, [{ kind: "claude-code", home }]);

    // What `record` without --session-id does: create/reuse a sessions row
    // and store it as mcp_session_id. Pull must not inherit that id.
    const mcp = (await createSession(db, { source_tool: "cli", project: null })).id;
    await insertEvent(db, {
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
    const facts = await factRows();
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

  it("keeps a disjoint successful conversation when a later one degrades", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
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
    expect(first.prefixCommitted).toBe(true);
    expect(first.examinedThrough).toBe(1);
    const rows = await factRows();
    expect(rows.map((r) => r.session_id)).toEqual(["sess-aaa"]);
    const watermark = (await db
      .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
      .get()) as { seq: number };
    expect(watermark.seq).toBe(1);

    const { provider, calls: secondCalls } = recording();
    const second = await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(second.extractionDegraded).toBe(false);
    expect(secondCalls[0]?.events).toEqual(["Alex is allergic to shellfish."]);
    expect((await factRows()).map((f) => f.session_id).sort()).toEqual([
      "sess-aaa",
      "sess-bbb",
    ]);
  });

  it("keeps that disjoint prefix on extract-only (threshold moment)", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
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
        if (calls === 2) return { facts: [], degraded: true };
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

    const first = await consolidate(
      db,
      flaky as never,
      { extraction: { enabled: true } as never },
      null,
      { copy: false, extract: true, integrate: false },
    );
    expect(first.extractionDegraded).toBe(true);
    const staged = (await db
      .prepare(
        `SELECT session_id, consolidation_id FROM session_facts ORDER BY created_at ASC`,
      )
      .all()) as Array<{ session_id: string; consolidation_id: string | null }>;
    expect(staged.map((r) => r.session_id)).toEqual(["sess-aaa"]);
    expect(staged[0]!.consolidation_id).toBeNull();
    const watermark = (await db
      .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
      .get()) as { seq: number };
    expect(watermark.seq).toBe(1);
  });

  it("advances the extract-only watermark for an empty honest prefix", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });

    let calls = 0;
    const flaky = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents() {
        calls += 1;
        if (calls === 2) return { facts: [], degraded: true };
        return { facts: [], degraded: false };
      },
    };

    const first = await consolidate(
      db,
      flaky as never,
      { extraction: { enabled: true } as never },
      null,
      { copy: false, extract: true, integrate: false },
    );
    expect(first.extractionDegraded).toBe(true);
    expect(await factRows()).toEqual([]);
    const watermark = (await db
      .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
      .get()) as { seq: number };
    expect(watermark.seq).toBe(1);
  });

  it("keeps a successful conversation when interleaved neighbour degrades", async () => {
    // aaa at 1 and 3, bbb at 2 and 4. Per-conversation marks keep aaa;
    // global through is MIN (hole at 2), not aaa's 3 — prune cannot delete bbb.
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex also prefers dark roast.",
    });
    await insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex avoids the seafood platter.",
    });

    let calls = 0;
    const flaky = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents(events: SessionEvent[]) {
        calls += 1;
        if (calls === 2) return { facts: [], degraded: true };
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
    expect(first.prefixCommitted).toBe(true);
    const rows = await factRows();
    expect(rows.map((r) => r.session_id)).toEqual(["sess-aaa", "sess-aaa"]);
    expect(rows.map((r) => r.content)).toEqual([
      "Alex prefers oat milk at Acme.",
      "Alex also prefers dark roast.",
    ]);
    expect(first.examinedThrough).toBe(1);
    expect(await extractWatermark(db)).toBe(1);
    expect(await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" })).toBe(3);
    expect(await conversationExtractThrough(db, { kind: "client", id: "sess-bbb" })).toBe(0);
    await pruneEvents(db, 0);
    const left = (
      (await db
        .prepare(`SELECT sequence FROM session_events ORDER BY sequence ASC`)
        .all()) as Array<{ sequence: number }>
    ).map((r) => r.sequence);
    expect(left).toContain(2);
    expect(left).toContain(3);
    expect(left).toContain(4);

    const { provider, calls: secondCalls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(secondCalls.map((c) => c.events).flat()).toEqual([
      "Alex is allergic to shellfish.",
      "Alex avoids the seafood platter.",
    ]);
  });

  it("continues a later conversation in the same run after a neighbour degrades", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });
    await insertEvent(db, {
      client_session_id: "sess-ccc",
      event_type: "message",
      role: "user",
      content: "Alex works at Acme.",
    });

    let calls = 0;
    const flaky = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents(events: SessionEvent[]) {
        calls += 1;
        if (calls === 2) return { facts: [], degraded: true };
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
    expect((await factRows()).map((r) => r.session_id).sort()).toEqual([
      "sess-aaa",
      "sess-ccc",
    ]);
  });

  it("still extracts a later conversation when the first call degrades", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
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
        if (calls === 1) return { facts: [], degraded: true };
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
    expect((await factRows()).map((r) => r.session_id)).toEqual(["sess-bbb"]);
    expect(await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" })).toBe(0);
  });

  it("does not re-read another conversation as evidence across a hole", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex also prefers dark roast.",
    });
    let calls = 0;
    const flaky = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents() {
        calls += 1;
        if (calls === 2) return { facts: [], degraded: true };
        return { facts: [], degraded: false };
      },
    };
    await consolidate(db, flaky as never, {
      extraction: { enabled: true } as never,
    });
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex likes tea at Acme.",
    });
    const { provider, calls: next } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    const aaa = next.find((c) => c.events.includes("Alex likes tea at Acme."));
    expect(aaa).toBeDefined();
    expect(aaa!.events).toEqual(["Alex likes tea at Acme."]);
    expect(aaa!.workingMemory).toEqual(
      expect.arrayContaining([
        "Alex prefers oat milk at Acme.",
        "Alex also prefers dark roast.",
      ]),
    );
    expect(aaa!.workingMemory.join(" ")).not.toContain("shellfish");
  });

  it("does not advance extract marks on integrate-only", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await consolidate(
      db,
      recording().provider as never,
      { extraction: { enabled: true } as never },
      null,
      { copy: false, extract: false, integrate: true },
    );
    expect(await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" })).toBe(0);
    expect(await extractWatermark(db)).toBe(0);
  });
});

describe("working memory is kind-branched", () => {
  it("includes dual-id MCP rows in the client window and excludes mcp-only collisions", async () => {
    await insertEvent(db, {
      mcp_session_id: "mcp-x",
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "dual-id prior from the same Claude chat",
    });
    await insertEvent(db, {
      mcp_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "mcp-only collision with the client id string",
    });
    const prior = (await db
      .prepare(
        `SELECT sequence FROM session_events WHERE client_session_id = 'sess-aaa' LIMIT 1`,
      )
      .get()) as { sequence: number };
    await setConversationExtractThrough(
      db,
      { kind: "client", id: "sess-aaa" },
      prior.sequence,
    );

    await insertEvent(db, {
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
