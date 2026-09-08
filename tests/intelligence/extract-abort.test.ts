/**
 * Ctrl+C during extract must not persist the in-flight conversation,
 * must not start integrate, and must release the lock.
 *
 * Synthetic fixtures only — Alex / Acme.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import type { SessionEvent } from "../../src/types/data.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";
import { ConsolidateAbortError } from "../../src/intelligence/abort.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
const { conversationExtractThrough } = await import("../../src/db/extract-watermarks.js");
const { getLockState } = await import("../../src/db/consolidation-lock.js");

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("extract abort", () => {
  it("drops conversation 2, keeps conversation 1 unclaimed, and releases the lock", async () => {
    await insertEvent(db, {
      client_session_id: "sess-one",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await insertEvent(db, {
      client_session_id: "sess-two",
      event_type: "message",
      role: "user",
      content: "Alex is allergic to shellfish.",
    });
    const abort = new AbortController();
    let calls = 0;
    const provider = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents(events: SessionEvent[]) {
        calls += 1;
        if (calls >= 2) {
          abort.abort();
          return { facts: [], degraded: false, aborted: true };
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
    await expect(
      consolidate(
        db,
        provider as never,
        { extraction: { enabled: true } } as never,
        null,
        { copy: false, extract: true, integrate: true },
        { abort: abort.signal, extractLimit: null },
      ),
    ).rejects.toBeInstanceOf(ConsolidateAbortError);
    expect(calls).toBe(2);
    expect(
      await conversationExtractThrough(db, { kind: "client", id: "sess-one" }),
    ).toBeGreaterThan(0);
    expect(
      await conversationExtractThrough(db, { kind: "client", id: "sess-two" }),
    ).toBe(0);
    const staged = (await db
      .prepare(
        `SELECT content, consolidation_id FROM session_facts ORDER BY created_at ASC`,
      )
      .all()) as Array<{ content: string; consolidation_id: string | null }>;
    expect(staged).toHaveLength(1);
    expect(staged[0]!.consolidation_id).toBeNull();
    expect(staged[0]!.content).toContain("oat milk");
    expect(await getLockState(db)).toBeNull();
  });

  it("unclaims after claim when integrate throws abort", async () => {
    await insertEvent(db, {
      client_session_id: "sess-one",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    const provider = {
      ...createHeuristicProvider(PERSONAL_VOCABULARY),
      async extractFactsFromEvents(events: SessionEvent[]) {
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
      async extractEntities() {
        throw new ConsolidateAbortError();
      },
    };
    await expect(
      consolidate(
        db,
        provider as never,
        { extraction: { enabled: true } } as never,
        null,
        { copy: false, extract: true, integrate: true },
        { extractLimit: null },
      ),
    ).rejects.toBeInstanceOf(ConsolidateAbortError);
    const staged = (await db
      .prepare(`SELECT consolidation_id FROM session_facts`)
      .all()) as Array<{ consolidation_id: string | null }>;
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every((r) => r.consolidation_id == null)).toBe(true);
    expect(await getLockState(db)).toBeNull();
  });
});
