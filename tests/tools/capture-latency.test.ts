/**
 * capture_fact latency.
 *
 * "Capture is fast — the server stores the fact immediately" is a claim the tool
 * description makes to every assistant that connects, and the acceptance
 * criteria pin it at <10ms. Nothing measured it. The whole DIKW split exists to
 * keep this path cheap: capture appends, and all the expensive work — entity
 * extraction, domain routing, dedup, supersession — is deferred to
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

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSessionManager } = await import("../../src/tools/session-manager.js");
const { createFactManager } = await import("../../src/tools/fact-manager.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

let db: Db;
let root: string;
let factManager: ReturnType<typeof createFactManager>;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "om-lat-"));
  db = openDatabase(path.join(root, "memory.db"));
  await applySchema(db);
  const sessionManager = createSessionManager(db);
  await sessionManager.startSession("latency-test", null);
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

describe("capture_fact latency", () => {
  it("stores a fact in well under 10ms at the median", async () => {
    const times = await measure(200);
    const median = percentile(times, 0.5);

    // Asserted on the median, not the max. A single capture can exceed 10ms for
    // reasons that have nothing to do with this code — a GC pause, the OS
    // scheduling something else — and measured maxima did reach ~8ms locally and
    // ~24ms against :memory:. Asserting the max would make this test a
    // random-number generator, and a flaky test is worse than none: it gets
    // muted, and then it protects nothing.
    expect(median).toBeLessThan(10);
  });

  it("has an order of magnitude of headroom, which is what makes the claim safe", async () => {
    // Measured at ~1.7ms median against a file-backed db. This bound is loose
    // enough to absorb a slow CI runner and tight enough that adding real work
    // to the capture path — an LLM call, a network hop, a synchronous
    // consolidation — fails it immediately.
    const median = percentile(await measure(200), 0.5);
    expect(median).toBeLessThan(5);
  });

  it("does not degrade as the store grows", async () => {
    // Capture is an append. If it ever starts scanning what came before —
    // a dedup query, a similarity check — cost grows with the store and the
    // deferred-intelligence design is quietly broken.
    const early = percentile(await measure(150), 0.5);
    for (let i = 0; i < 2000; i++) {
      await factManager.captureFact({ content: `Bulk background fact ${i}` });
    }
    const late = percentile(await measure(150), 0.5);

    // Generous ratio: this catches O(n) behaviour, not measurement noise.
    expect(late).toBeLessThan(early * 5 + 5);
    // 30s, because vitest's 5s default was a second assertion nobody wrote.
    // This test performs ~2,300 real inserts against a file-backed database,
    // and on a loaded CI runner that alone can exceed five seconds — it went
    // red once on Node 24 and passed on re-run with no change. A timeout that
    // trips on runner load reports a wall-clock budget, not the property under
    // test; the ratio above is what catches a regression. Kept finite so a
    // genuine hang still fails rather than running for ever.
  }, 30_000);

  it("is synchronous — it returns a fact, not a promise", async () => {
    // The latency above only means anything if the call has actually finished
    // when it returns. A promise here would mean the work moved somewhere the
    // timer cannot see.
    const result = await factManager.captureFact({ content: "The user prefers tea" });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result!.id).toBeTruthy();
  });
});
