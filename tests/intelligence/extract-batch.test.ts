/**
 * Extract honours batch_size, truncates every prompt array, and keeps an
 * honest prefix when a later chunk degrades.
 *
 * Synthetic fixtures only — Alex / Acme.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import type { SessionEvent } from "../../src/types/data.js";
import type { ExtractionOutcome } from "../../src/intelligence/types.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
const { latestConversationSituation } = await import("../../src/db/consolidations.js");
const { conversationExtractThrough } = await import("../../src/db/extract-watermarks.js");

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

interface ExtractCall {
  contents: string[];
  evidence: string[];
  reminders: string[];
  now: string | null | undefined;
  domainNames: string[];
  entityTypes: string[];
}

function recording(
  handler?: (
    events: SessionEvent[],
    callIndex: number,
  ) => ExtractionOutcome,
) {
  const calls: ExtractCall[] = [];
  const provider = {
    ...createHeuristicProvider(PERSONAL_VOCABULARY),
    async extractFactsFromEvents(
      events: SessionEvent[],
      workingMemory: SessionEvent[],
      _summary: string | null,
      _ltm: unknown,
      extras?: {
        now?: string | null;
        reminderEvents?: SessionEvent[];
        vocabulary?: { name: string }[];
        entityTypes?: string[];
      },
    ) {
      const callIndex = calls.length;
      calls.push({
        contents: events.map((e) => e.content ?? ""),
        evidence: workingMemory.map((e) => e.content ?? ""),
        reminders: (extras?.reminderEvents ?? []).map((e) => e.content ?? ""),
        now: extras?.now,
        domainNames: (extras?.vocabulary ?? []).map((d) => d.name),
        entityTypes: extras?.entityTypes ?? [],
      });
      if (handler) return handler(events, callIndex);
      return {
        facts: events
          .filter((e) => e.content)
          .map((e) => ({
            content: e.content as string,
            domain_hint: "preferences",
          })),
        degraded: false,
        now: `desk-${callIndex + 1}`,
      };
    },
  };
  return { provider, calls };
}

async function seedConversation(n: number, prefix = "line"): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: `${prefix} ${i + 1} about oat milk at Acme`,
    });
  }
}

async function factContents(): Promise<string[]> {
  return (
    (await db
      .prepare(`SELECT content FROM session_facts ORDER BY created_at ASC`)
      .all()) as Array<{ content: string }>
  ).map((r) => r.content);
}

async function eventWatermark(): Promise<number> {
  return (
    (await db
      .prepare(
        `SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`,
      )
      .get()) as { seq: number }
  ).seq;
}

describe("extraction.batch_size is read by extract", () => {
  it("chunks one conversation into calls of that size", async () => {
    await seedConversation(5);
    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true, batch_size: 2 } as never,
    });
    expect(calls.map((c) => c.contents.length)).toEqual([2, 2, 1]);
  });

  it("truncates candidates and still chunks", async () => {
    await seedConversation(5, "abcdefghij extra");
    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true, batch_size: 2, max_content_length: 8 } as never,
    });
    expect(calls.map((c) => c.contents.length)).toEqual([2, 2, 1]);
    for (const call of calls) {
      for (const content of call.contents) {
        expect(content.length).toBeLessThanOrEqual(8);
      }
    }
  });

  it("uses DEFAULT_CONFIG.extraction.batch_size when the field is omitted", async () => {
    const size = DEFAULT_CONFIG.extraction.batch_size;
    await seedConversation(size + 1);
    const { provider, calls } = recording();
    // 51 events is over the per-run extract cap; this test is about chunking,
    // so lift the cap the way `consolidate --all` does.
    await consolidate(
      db,
      provider as never,
      { extraction: { enabled: true } as never },
      null,
      { copy: false, extract: true, integrate: true },
      { extractLimit: null },
    );
    expect(calls.map((c) => c.contents.length)).toEqual([size, 1]);
  });
});

describe("later chunks see earlier-chunk desk, not earlier candidates", () => {
  it("passes the previous now and a tail of earlier events as evidence", async () => {
    await seedConversation(4);
    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true, batch_size: 2 } as never,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.now).toBe("desk-1");
    expect(calls[1]!.contents.some((c) => calls[0]!.contents.includes(c))).toBe(
      false,
    );
    expect(
      calls[1]!.evidence.some((c) => calls[0]!.contents.includes(c)),
    ).toBe(true);
  });
});

describe("evidence and reread windows obey max_content_length", () => {
  it("truncates pre-watermark evidence and reminder events", async () => {
    const long = "x".repeat(10_000);
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: long,
    });
    await consolidate(db, recording().provider as never, {
      extraction: { enabled: true, max_content_length: 20 } as never,
    });
    expect(await eventWatermark()).toBeGreaterThan(0);

    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "short new line",
    });
    const { provider, calls } = recording(() => ({
      facts: [],
      degraded: false,
      confidence: 0.1,
    }));
    await consolidate(db, provider as never, {
      extraction: { enabled: true, max_content_length: 20 } as never,
    });
    const withEvidence = calls.find((c) => c.evidence.length > 0);
    expect(withEvidence).toBeDefined();
    for (const content of withEvidence!.evidence) {
      expect(content.length).toBeLessThanOrEqual(20);
    }
    const withReminders = calls.find((c) => c.reminders.length > 0);
    expect(withReminders).toBeDefined();
    for (const content of withReminders!.reminders) {
      expect(content.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("unconfident first chunk does not hold the conversation", () => {
  it("keeps facts from a later successful chunk and completes the watermark", async () => {
    await seedConversation(4);
    const { provider, calls } = recording((events, callIndex) => {
      if (callIndex === 0 || callIndex === 1) {
        return { facts: [], degraded: false, confidence: 0.1 };
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
    });
    await consolidate(db, provider as never, {
      extraction: { enabled: true, batch_size: 2 } as never,
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const facts = await factContents();
    expect(facts.some((c) => c.includes("line 1 "))).toBe(false);
    expect(facts.some((c) => c.includes("line 3 "))).toBe(true);
    expect(await eventWatermark()).toBe(4);
  });
});

describe("chunked topic shift closes segments at distinct clocks", () => {
  it("ends the first segment at the old watermark, not the new chunk", async () => {
    await db
      .prepare(
        `INSERT INTO consolidations
         (id, session_id, facts_in, facts_integrated, facts_rejected,
          entities_created, entities_linked, supersessions,
          summary, open_threads, last_event_sequence, created_at,
          now, now_start_sequence, now_referents, segments)
         VALUES ('prior-desk', 'sess-aaa', 0, 0, 0, 0, 0, 0, NULL, NULL, 0,
                 datetime('now'), 'prior desk', 0, '[]', '[]')`,
      )
      .run();
    await seedConversation(4);
    const { provider } = recording(() => ({
      facts: [{ content: "Alex prefers oat milk at Acme.", domain_hint: "preferences" }],
      degraded: false,
      now: "new desk",
      topic_shifted: true,
    }));
    await consolidate(db, provider as never, {
      extraction: { enabled: true, batch_size: 2 } as never,
    });
    const situation = await latestConversationSituation(db, "sess-aaa");
    expect(situation).toBeDefined();
    const ends = (situation!.segments ?? []).map((s) => s.end_sequence);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ends).size).toBe(ends.length);
    expect(ends[0]).toBe(0);
  });
});

describe("a failed later chunk keeps the honest prefix", () => {
  it("persists the first chunk on extract-only and watermarks its last sequence", async () => {
    await seedConversation(4);
    const { provider } = recording((_events, callIndex) => {
      if (callIndex === 1) return { facts: [], degraded: true };
      return {
        facts: [
          { content: "Alex prefers oat milk at Acme.", domain_hint: "preferences" },
        ],
        degraded: false,
      };
    });
    const result = await consolidate(
      db,
      provider as never,
      { extraction: { enabled: true, batch_size: 2 } as never },
      null,
      { copy: false, extract: true, integrate: false },
    );
    expect(result.extractionDegraded).toBe(true);
    expect(result.prefixCommitted).toBe(true);
    const staged = (await db
      .prepare(
        `SELECT content, consolidation_id FROM session_facts ORDER BY created_at ASC`,
      )
      .all()) as Array<{ content: string; consolidation_id: string | null }>;
    expect(staged).toHaveLength(1);
    expect(staged[0]!.consolidation_id).toBeNull();
    expect(await eventWatermark()).toBe(2);
  });
});

describe("a failed first chunk holds the mark and still extracts a neighbour", () => {
  it("does not watermark through an unread prefix of a multi-chunk conversation", async () => {
    await seedConversation(4);
    await insertEvent(db, {
      client_session_id: "sess-bbb",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });
    const timeouts: string[] = [];
    const { provider, calls } = recording((_events, callIndex) => {
      if (callIndex === 0) return { facts: [], degraded: true };
      return {
        facts: _events
          .filter((e) => e.content)
          .map((e) => ({
            content: e.content as string,
            domain_hint: "preferences",
          })),
        degraded: false,
      };
    });
    const result = await consolidate(
      db,
      provider as never,
      { extraction: { enabled: true, batch_size: 2 } as never },
      null,
      { copy: false, extract: true, integrate: false },
      { onExtractTimeout: () => timeouts.push("timeout") },
    );
    expect(result.extractionDegraded).toBe(true);
    expect(timeouts).toEqual([]);
    expect(
      await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" }),
    ).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.contents.join(" ")).toContain("shellfish");
    expect(
      await conversationExtractThrough(db, { kind: "client", id: "sess-bbb" }),
    ).toBeGreaterThan(0);
  });

  it("fires onExtractTimeout only when degradedKind is timeout", async () => {
    await seedConversation(2);
    const timeouts: string[] = [];
    const { provider } = recording(() => ({
      facts: [],
      degraded: true,
      degradedKind: "timeout",
    }));
    const result = await consolidate(
      db,
      provider as never,
      { extraction: { enabled: true, batch_size: 2 } as never },
      null,
      { copy: false, extract: true, integrate: false },
      { onExtractTimeout: () => timeouts.push("timeout") },
    );
    expect(result.extractionDegraded).toBe(true);
    expect(timeouts).toEqual(["timeout"]);
    expect(
      await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" }),
    ).toBe(0);
  });
});

describe("extraction.enabled false with events is policy, not provider-down", () => {
  it("does not call extract and still advances the watermark", async () => {
    await seedConversation(3);
    let extractCalls = 0;
    const { provider } = recording(() => {
      extractCalls += 1;
      return { facts: [], degraded: false };
    });
    const result = await consolidate(db, provider as never, {
      extraction: { enabled: false } as never,
    });
    expect(extractCalls).toBe(0);
    expect(result.extractionDegraded).toBeFalsy();
    expect(await eventWatermark()).toBe(3);
    expect(await factContents()).toEqual([]);
  });
});

describe("extract sees the store's own vocabulary", () => {
  it("passes domains and entity types from the database, not empty config", async () => {
    const { ensureDomain } = await import("../../src/db/domains.js");
    const { findOrCreateEntity } = await import("../../src/db/entities.js");
    await ensureDomain(db, "warehouse");
    await findOrCreateEntity(db, { name: "stg_orders", type: "dbt_model" });
    await seedConversation(1);
    const { provider, calls } = recording();
    await consolidate(db, provider as never, {
      extraction: { enabled: true } as never,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.domainNames).toContain("warehouse");
    expect(calls[0]!.entityTypes).toContain("dbt_model");
  });
});
