/**
 * D→I situation: now, referents, segments, K-not-veto, forgetfulness reread.
 * Synthetic fixtures only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "../../src/db/connection.js";
import type { SessionEvent, SessionFact, Fact } from "../../src/types/data.js";
import type { ExtractExtras, ExtractionOutcome } from "../../src/intelligence/types.js";
import {
  EXTRACT_EVIDENCE_SLICE,
  EXTRACT_CONTEXT_CONTRACT,
} from "../../src/intelligence/extract-prompt.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const { insertFact } = await import("../../src/db/facts.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
const { latestConversationSituation } = await import(
  "../../src/db/consolidations.js"
);
const { PERSONAL_VOCABULARY } = await import("../fixtures/vocabulary.js");

let db: Db;
let tmpRoot: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
  tmpRoot = mkdtempSync(path.join(tmpdir(), "om-extract-ctx-"));
});

afterEach(() => {
  closeDatabase(db);
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface ExtractCall {
  events: string[];
  workingMemory: string[];
  sessionSummary: string | null;
  extras: ExtractExtras | undefined;
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

function watermark() {
  return (
    db
      .prepare(
        `SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`,
      )
      .get() as { seq: number }
  ).seq;
}

function situation(sessionId: string) {
  const s = latestConversationSituation(db, sessionId);
  if (!s) return undefined;
  return {
    now: s.now,
    now_start_sequence: s.now_start_sequence,
    now_referents: JSON.stringify(s.referents),
    segments: JSON.stringify(s.segments),
  };
}

function recording(
  handler: (
    events: SessionEvent[],
    workingMemory: SessionEvent[],
    extras?: ExtractExtras,
  ) => ExtractionOutcome | Promise<ExtractionOutcome>,
) {
  const calls: ExtractCall[] = [];
  const provider = {
    ...createHeuristicProvider(PERSONAL_VOCABULARY),
    async extractFactsFromEvents(
      events: SessionEvent[],
      workingMemory: SessionEvent[],
      sessionSummary: string | null,
      _ltm?: Fact[],
      extras?: ExtractExtras,
    ) {
      calls.push({
        events: events.map((e) => e.content ?? ""),
        workingMemory: workingMemory.map((e) => e.content ?? ""),
        sessionSummary: sessionSummary ?? null,
        extras,
      });
      return handler(events, workingMemory, extras);
    },
    async summarise(
      facts: SessionFact[],
      _graduated: Fact[],
      prior: string | null,
    ) {
      const id = facts[0]?.session_id ?? "unknown";
      return { summary: `rolling summary of ${id}`, openThreads: [] };
    },
  };
  return { provider, calls };
}

function fromCandidates(events: SessionEvent[]): ExtractionOutcome {
  return {
    facts: events
      .filter((e) => e.content)
      .map((e) => ({
        content: e.content as string,
        domain_hint: "preferences",
      })),
    degraded: false,
  };
}

describe("K is cue not veto", () => {
  it("extracts a contradicting line rather than dropping it because K disagreed", async () => {
    insertFact(db, {
      content: "Alex prefers coffee.",
      domain: "preferences",
      source_type: "conversation",
    });
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex no longer drinks coffee.",
    });

    const { provider, calls } = recording((events) => ({
      facts: [
        {
          content: "Alex no longer drinks coffee.",
          domain_hint: "preferences",
        },
      ],
      degraded: false,
    }));
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].extras).toBeDefined();
    expect(factRows()).toEqual([
      {
        session_id: "sess-aaa",
        content: "Alex no longer drinks coffee.",
      },
    ]);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/CONTRADICTS long_term_memory/);
  });

  it("does not insert a referent as a session_fact", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Let's change the programme.",
    });
    const { provider } = recording(() => ({
      facts: [],
      degraded: false,
      now: "changing the programme",
      referents: [
        { phrase: "the programme", binding: "this branch" },
      ],
    }));
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(factRows()).toEqual([]);
    const row = situation("sess-aaa");
    expect(row).toBeDefined();
    expect(JSON.parse(row!.now_referents ?? "[]")).toEqual([
      { phrase: "the programme", binding: "this branch" },
    ]);
  });
});

describe("forgetfulness reread", () => {
  it("rereads this session once and does not put reminder lines in candidates", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {
      extraction: { enabled: true } as never,
    });
    expect(watermark()).toBeGreaterThan(0);

    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "that approach is better",
    });
    insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });

    const rec = recording((events, _wm, extras) => {
      if (
        !extras?.reminderEvents?.length &&
        events.some((e) => (e.content ?? "").includes("that approach"))
      ) {
        return { facts: [], degraded: false, confidence: 0.2 };
      }
      if (extras?.reminderEvents?.length) {
        return {
          facts: events
            .filter((e) => e.content)
            .map((e) => ({
              content: e.content as string,
              domain_hint: "preferences",
            })),
          degraded: false,
          confidence: 0.9,
        };
      }
      return fromCandidates(events);
    });

    await consolidate(db, rec.provider as never, {
      extraction: { enabled: true } as never,
    });

    const approachCalls = rec.calls.filter((c) =>
      c.events.some((e) => e.includes("that approach")),
    );
    expect(approachCalls).toHaveLength(2);
    expect(approachCalls[1].events).toEqual(approachCalls[0].events);
    expect(
      (approachCalls[1].extras?.reminderEvents ?? []).some((e) =>
        (e.content ?? "").includes("oat milk"),
      ),
    ).toBe(true);
    expect(approachCalls[1].events.join(" ")).not.toContain("oat milk");
    const rows = factRows();
    expect(rows.some((r) => r.content.includes("that approach"))).toBe(true);
    expect(rows.some((r) => r.content.includes("oat milk"))).toBe(false);
    expect(rows.some((r) => r.content.includes("shellfish"))).toBe(true);
  });

  it("does not reread a heuristic-style confident empty extract", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "hello",
    });
    let calls = 0;
    const { provider } = recording(() => {
      calls += 1;
      return { facts: [], degraded: false };
    });
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(calls).toBe(1);
    expect(watermark()).toBeGreaterThan(0);
  });

  it("holds the watermark when the provider could not run", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    let calls = 0;
    const { provider } = recording(() => {
      calls += 1;
      return { facts: [], degraded: true };
    });
    const result = await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(result.extractionDegraded).toBe(true);
    expect(calls).toBe(1);
    expect(factRows()).toEqual([]);
    expect(watermark()).toBe(0);
  });

  it("advances after an unconfident reread rather than holding", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "that thing",
    });
    const { provider } = recording(() => ({
      facts: [],
      degraded: false,
      confidence: 0.1,
    }));
    const result = await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(result.extractionDegraded).toBe(false);
    expect(factRows()).toEqual([]);
    expect(watermark()).toBeGreaterThan(0);
    expect(situation("sess-aaa")).toBeUndefined();
  });
});

describe("now, referents, segments", () => {
  it("does not close a segment when only a referent rebinds", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "changing D→I in consolidate.ts",
    });
    const first = recording(() => ({
      facts: [{ content: "The user is changing D→I.", domain_hint: "work" }],
      degraded: false,
      now: "changing D→I",
      referents: [{ phrase: "the file", binding: "consolidate.ts" }],
      topic_shifted: false,
    }));
    await consolidate(db, first.provider as never, {
      extraction: { enabled: true } as never,
    });
    const start = situation("sess-aaa")!.now_start_sequence;

    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "the file is now sampling.ts",
    });
    const second = recording(() => ({
      facts: [],
      degraded: false,
      now: "changing D→I",
      referents: [{ phrase: "the file", binding: "sampling.ts" }],
      topic_shifted: false,
    }));
    await consolidate(db, second.provider as never, {
      extraction: { enabled: true } as never,
    });

    const row = situation("sess-aaa")!;
    expect(row.now).toBe("changing D→I");
    expect(row.now_start_sequence).toBe(start);
    expect(JSON.parse(row.now_referents ?? "[]")).toEqual([
      { phrase: "the file", binding: "sampling.ts" },
    ]);
    expect(JSON.parse(row.segments ?? "[]")).toEqual([]);
  });

  it("picks the later run when two rows share a created_at", () => {
    const ts = "2026-08-25T12:00:00.000Z";
    const insert = db.prepare(
      `INSERT INTO consolidations
         (id, session_id, facts_in, facts_graduated, facts_rejected,
          entities_created, entities_linked, supersessions,
          summary, open_threads, last_event_sequence, created_at,
          now, now_referents, segments)
       VALUES (?, 'sess-aaa', 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?,
               'changing D→I', ?, '[]')`,
    );
    // Higher watermark first so a rowid-only ORDER BY would pick the wrong
    // row. created_at alone is what flaked on Node 24 CI.
    insert.run(
      "c-later",
      2,
      ts,
      JSON.stringify([{ phrase: "the file", binding: "sampling.ts" }]),
    );
    insert.run(
      "c-earlier",
      1,
      ts,
      JSON.stringify([{ phrase: "the file", binding: "consolidate.ts" }]),
    );
    const row = situation("sess-aaa")!;
    expect(JSON.parse(row.now_referents ?? "[]")).toEqual([
      { phrase: "the file", binding: "sampling.ts" },
    ]);
  });

  it("restores gist and referents from a closed segment on topic return", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "the programme is oat milk at Acme",
    });
    await consolidate(
      db,
      recording(() => ({
        facts: [
          {
            content: "Alex prefers oat milk at Acme.",
            domain_hint: "preferences",
          },
        ],
        degraded: false,
        now: "oat-milk work",
        referents: [{ phrase: "the programme", binding: "oat milk" }],
      })).provider as never,
      { extraction: { enabled: true } as never },
    );

    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });
    await consolidate(
      db,
      recording(() => ({
        facts: [
          {
            content: "Alex is allergic to shellfish.",
            domain_hint: "medical",
          },
        ],
        degraded: false,
        now: "shellfish allergy",
        referents: [{ phrase: "the allergy", binding: "shellfish" }],
        topic_shifted: true,
      })).provider as never,
      { extraction: { enabled: true } as never },
    );

    const afterShift = situation("sess-aaa")!;
    const segs = JSON.parse(afterShift.segments ?? "[]") as Array<{
      gist: string;
      referents: Array<{ phrase: string; binding: string }>;
    }>;
    expect(segs).toHaveLength(1);
    expect(segs[0].gist).toBe("oat-milk work");
    expect(segs[0].referents).toEqual([
      { phrase: "the programme", binding: "oat milk" },
    ]);

    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "back to the programme",
    });
    insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "unrelated other conversation",
    });
    const third = recording((events) => fromCandidates(events));
    await consolidate(db, third.provider as never, {
      extraction: { enabled: true } as never,
    });
    const back = third.calls.find((c) =>
      c.events.some((e) => e.includes("programme")),
    );
    expect(back).toBeDefined();
    expect(back!.extras?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gist: "oat-milk work",
          referents: [{ phrase: "the programme", binding: "oat milk" }],
        }),
      ]),
    );
    expect(back!.sessionSummary).not.toContain("sess-bbb");
    const other = third.calls.find((c) =>
      c.events.some((e) => e.includes("unrelated")),
    );
    expect(other!.extras?.segments ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gist: "oat-milk work" }),
      ]),
    );
  });

  it("stores at most eight referents from the model's list", async () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "many nicknames",
    });
    const nine = Array.from({ length: 9 }, (_, i) => ({
      phrase: `p${i}`,
      binding: `b${i}`,
    }));
    await consolidate(
      db,
      recording(() => ({
        facts: [],
        degraded: false,
        now: "many nicknames",
        referents: nine,
      })).provider as never,
      { extraction: { enabled: true } as never },
    );
    const stored = JSON.parse(situation("sess-aaa")!.now_referents ?? "[]");
    expect(stored).toHaveLength(8);
    expect(stored[0].phrase).toBe("p0");
    expect(stored[7].phrase).toBe("p7");
  });

  it("passes a short evidence prefix, not the whole spared pool", async () => {
    for (let i = 0; i < 20; i++) {
      insertEvent(db, {
        client_session_id: "sess-aaa",
        event_type: "message",
        role: "user",
        content: i === 0 ? "oldest distinctive line about Edinburgh" : `prior ${i}`,
      });
    }
    await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY), {
      extraction: { enabled: true } as never,
    });

    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    const { provider, calls } = recording((events) => fromCandidates(events));
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].workingMemory.length).toBeLessThanOrEqual(
      EXTRACT_EVIDENCE_SLICE,
    );
    expect(calls[0].workingMemory.join(" ")).not.toContain("Edinburgh");
  });
});
