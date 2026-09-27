/**
 * capture_fact latency.
 *
 * "Capture is fast — the server stores the fact immediately" is a claim the tool
 * description makes to every assistant that connects. The whole DIKW split
 * exists to keep this path cheap: capture appends, and all the expensive work —
 * entity extraction, domain routing, dedup, supersession — is deferred to
 * consolidation. If something heavy ever creeps into capture, the design's
 * central trade is broken and the description becomes a lie.
 *
 * What this guards is that regression, not a precise number. A real breach would
 * be orders of magnitude — an LLM call, a network hop, a synchronous
 * consolidation — not a few milliseconds of drift.
 *
 * Measured against a file-backed database, not :memory:, because that is what a
 * user has: WAL, fsync, a real page cache.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase, withTransaction } = await import(
  "../../src/db/connection.js"
);
const { applySchema } = await import("../../src/db/schema.js");
const { insertSessionFact, getFactSources } = await import(
  "../../src/db/session-facts.js"
);
const { insertEvent } = await import("../../src/db/sessions.js");
const { createSessionManager } = await import("../../src/tools/session-manager.js");
const { createFactManager } = await import("../../src/tools/fact-manager.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

/** Extra rows that make an O(n) scan fail the 5× late/early bound. */
const GROW_EXTRA = 2000;

let db: Db;
let root: string;
let sessionId: string;
let factManager: ReturnType<typeof createFactManager>;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "om-lat-"));
  db = openDatabase(path.join(root, "memory.db"));
  await applySchema(db);
  const sessionManager = createSessionManager(db);
  sessionId = (await sessionManager.startSession("latency-test", null)).id;
  factManager = createFactManager(db, sessionManager, {
    intelligence: createHeuristicProvider(PERSONAL_VOCABULARY),
  });
});

afterEach(async () => {
  await closeDatabase(db);
  rmSync(root, { recursive: true, force: true });
});

/** Capture `n` facts, returning each call's duration in milliseconds, sorted. */
async function measure(n: number): Promise<number[]> {
  // Warm up first: the first captures pay for statement preparation and page
  // cache misses, which is startup cost rather than per-capture cost.
  for (let i = 0; i < 20; i++) await factManager.captureFact({ content: `Warmup fact ${i}` });

  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    await factManager.captureFact({ content: `The user prefers beverage variant ${i}` });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return times.sort((a, b) => a - b);
}

const percentile = (sorted: number[], q: number) => sorted[Math.floor(sorted.length * q)];

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function installPrepareSpy(db: Db): { sql: string[]; restore: () => void } {
  const sql: string[] = [];
  const original = db.prepare;
  db.prepare = (statement: string) => {
    sql.push(statement);
    return original.call(db, statement);
  };
  return {
    sql,
    restore: () => {
      db.prepare = original;
    },
  };
}

async function growFactsAndEvents(): Promise<void> {
  await withTransaction(db, async () => {
    for (let i = 0; i < GROW_EXTRA; i++) {
      await insertSessionFact(db, {
        session_id: sessionId,
        content: `Bulk background fact ${i}`,
      });
      await insertEvent(db, {
        mcp_session_id: sessionId,
        event_type: "message",
        role: "user",
        content: `Bulk background event ${i}`,
      });
    }
  });
}

describe("capture_fact latency", () => {
  it("stores a fact in well under 50ms at the median", async () => {
    const times = await measure(200);
    const median = percentile(times, 0.5);

    // Asserted on the median, not the max. A single capture can spike for
    // reasons that have nothing to do with this code — a GC pause, the OS
    // scheduling something else. Asserting the max would make this test a
    // random-number generator, and a flaky test is worse than none: it gets
    // muted, and then it protects nothing.
    //
    // 50ms is still two orders below an LLM call or a network hop, which is
    // the regression this guards. A local disk is ~2ms; GitHub's Windows
    // runner was ~20ms. The tool description's "immediately" is about that
    // gap, not a 10ms stopwatch on the fastest machine.
    expect(median).toBeLessThan(50);
  }, 30_000);

  it("has an order of magnitude of headroom, which is what makes the claim safe", async () => {
    // Local file-backed db is ~2ms. GitHub Windows was ~12–20ms. This bound
    // still fails the moment capture waits on an LLM, a network hop, or a
    // synchronous consolidation; it does not pretend every runner is a
    // quiet local SSD.
    const median = percentile(await measure(200), 0.5);
    expect(median).toBeLessThan(50);
  }, 30_000);

  it("does not degrade as the store grows", async () => {
    // Capture is an append. If it ever starts scanning what came before —
    // a dedup query, a similarity check — cost grows with the store and the
    // deferred-intelligence design is quietly broken.
    const early = percentile(await measure(150), 0.5);
    // Grow the table in one transaction. The property is captureFact
    // late/early, not the wall clock of 2000 individual commits. Using
    // captureFact here made the test a load detector: 2340 file-backed
    // inserts at a 50ms median (still inside the latency claim) exceed a
    // 90s timeout before the ratio runs. Events stay empty here so autoLink
    // does not add five extra commits to every timed capture; the spy test
    // below is what seeds events.
    await withTransaction(db, async () => {
      for (let i = 0; i < GROW_EXTRA; i++) {
        await insertSessionFact(db, {
          session_id: sessionId,
          content: `Bulk background fact ${i}`,
        });
      }
    });
    const late = percentile(await measure(150), 0.5);

    // Generous ratio: this catches O(n) behaviour, not measurement noise.
    expect(late).toBeLessThan(early * 5 + 5);
    // Finite so a genuine hang still fails rather than running for ever.
    // Budget is the two measure() loops (~340 captures), not GROW_EXTRA.
  }, 60_000);

  it("capture SQL stays bounded after the store has grown", async () => {
    // Disk noise can hide a cheap table scan in the late/early ratio.
    // This spies the statements captureFact actually prepares: it must not
    // read session_facts, and the events read must keep LIMIT so autoLink
    // cannot become O(events).
    await growFactsAndEvents();
    const spy = installPrepareSpy(db);
    let fact: Awaited<ReturnType<typeof factManager.captureFact>>;
    try {
      fact = await factManager.captureFact({
        content: "The user prefers spy-probe tea",
      });
    } finally {
      spy.restore();
    }

    expect(fact).not.toBeNull();
    const statements = spy.sql.map(oneLine);

    const factReads = statements.filter(
      (s) => /\bselect\b/i.test(s) && /\bfrom session_facts\b/i.test(s),
    );
    expect(factReads).toEqual([]);

    const factInserts = statements.filter((s) =>
      /\binsert or ignore into session_facts\b/i.test(s),
    );
    expect(factInserts).toHaveLength(1);

    const eventSelects = statements.filter(
      (s) => /\bselect\b/i.test(s) && /\bfrom session_events\b/i.test(s),
    );
    expect(eventSelects.length).toBeGreaterThan(0);
    for (const s of eventSelects) {
      expect(s).toMatch(/\blimit\s+\?/i);
    }

    const sources = await getFactSources(db, fact!.id);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.length).toBeLessThan(GROW_EXTRA);

    const sourceInserts = statements.filter((s) =>
      /\binsert or ignore into session_fact_sources\b/i.test(s),
    );
    expect(sourceInserts).toHaveLength(sources.length);
  }, 60_000);

  it("is synchronous — it returns a fact, not a promise", async () => {
    // The latency above only means anything if the call has actually finished
    // when it returns. A promise here would mean the work moved somewhere the
    // timer cannot see.
    const result = await factManager.captureFact({ content: "The user prefers tea" });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result!.id).toBeTruthy();
  });
});
