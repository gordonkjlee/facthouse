/**
 * getStats — the shared source of truth behind the `get_stats` tool and the
 * `openmemory stats` CLI. Its "currently true" filter is the part that matters:
 * facts are immutable and never deleted, so total and current legitimately
 * diverge, and a filter that drifts would quietly misreport the store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertFact } = await import("../../src/db/facts.js");
const { createSource } = await import("../../src/db/sources.js");
const { ensureDomain } = await import("../../src/db/domains.js");
const { getStats } = await import("../../src/db/stats.js");
const { insertEmbeddings } = await import("../../src/db/embeddings.js");

let db: Db;
let sourceId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
  sourceId = createSource(db, {
    type: "test",
    tool_id: null,
    raw_content: "x",
    metadata: {},
  }).id;
});

afterEach(() => closeDatabase(db));

function fact(content: string, domain = "preferences") {
  ensureDomain(db, domain);
  return insertFact(db, {
    content,
    domain,
    subdomain: null,
    confidence: 0.9,
    importance: 0.5,
    source_type: "conversation",
    source_tool: null,
    source_id: sourceId,
    session_id: null,
    capture_context: null,
    source_quality: "explicit",
  });
}

describe("getStats", () => {
  it("reports zeros on an empty store rather than throwing", () => {
    const s = getStats(db);
    expect(s.facts).toEqual({ active_latest: 0, total: 0 });
    expect(s.entities).toBe(0);
    expect(s.consolidations).toBe(0);
    expect(s.domain_distribution).toEqual([]);
  });

  it("counts a captured fact as both current and total", () => {
    fact("Prefers dark roast coffee");
    const s = getStats(db);
    expect(s.facts.active_latest).toBe(1);
    expect(s.facts.total).toBe(1);
  });

  it("keeps a superseded fact in total but drops it from current", () => {
    const old = fact("Prefers instant coffee");
    fact("Prefers dark roast coffee");
    db.prepare(
      `UPDATE facts SET status = 'superseded', is_latest = 0 WHERE id = ?`,
    ).run(old.id);

    const s = getStats(db);
    expect(s.facts.active_latest).toBe(1); // history is not "currently true"
    expect(s.facts.total).toBe(2); // but it is never deleted
  });

  it("excludes a fact whose validity window has closed", () => {
    const expired = fact("Lives in Springfield");
    db.prepare(`UPDATE facts SET valid_until = '2000-01-01T00:00:00Z' WHERE id = ?`).run(
      expired.id,
    );

    const s = getStats(db);
    expect(s.facts.active_latest).toBe(0);
    expect(s.facts.total).toBe(1);
  });

  it("keeps a fact whose validity window is still open", () => {
    const live = fact("Lives in Springfield");
    db.prepare(`UPDATE facts SET valid_until = '2999-01-01T00:00:00Z' WHERE id = ?`).run(
      live.id,
    );
    expect(getStats(db).facts.active_latest).toBe(1);
  });

  it("counts only current facts in the domain distribution", () => {
    const old = fact("Prefers instant coffee", "preferences");
    fact("Prefers dark roast coffee", "preferences");
    fact("Works at Acme", "work");
    db.prepare(
      `UPDATE facts SET status = 'superseded', is_latest = 0 WHERE id = ?`,
    ).run(old.id);

    const s = getStats(db);
    // Sorted by name here only to make the assertion order-independent: both
    // buckets are 1, so the query's ORDER BY count DESC is a tie and SQLite may
    // return either first. Ordering is asserted separately, on distinct counts.
    expect([...s.domain_distribution].sort((a, b) => a.domain.localeCompare(b.domain)))
      .toEqual([
        { domain: "preferences", count: 1 }, // the superseded fact must not inflate this
        { domain: "work", count: 1 },
      ]);
  });

  it("orders the domain distribution by count, largest first", () => {
    fact("a", "work");
    fact("b", "work");
    fact("c", "preferences");

    expect(getStats(db).domain_distribution[0]).toEqual({ domain: "work", count: 2 });
  });

  it("counts registered domains, not just those holding facts", () => {
    ensureDomain(db, "medical");
    fact("Works at Acme", "work");

    const s = getStats(db);
    expect(s.domains).toBe(2);
    expect(s.domain_distribution).toEqual([{ domain: "work", count: 1 }]);
  });
});

describe("getStats semantic coverage", () => {
  const vec = (...xs: number[]) => Float32Array.from(xs);

  it("is empty on a store that has never embedded anything", () => {
    insertFact(db, { content: "a fact", domain: "general", source_type: "explicit" });
    // Not `[{count: 0}]` — keyword-only is the default, and a zero row would
    // report a configured-and-failing provider on a store with no provider.
    expect(getStats(db).embeddings).toEqual([]);
  });

  it("reports each model and dimension separately", () => {
    // The state a single number hides: search reads one pair, so a store with
    // 3 vectors under the configured model and 3 under an abandoned one has
    // half the coverage a total of 6 would suggest.
    const a = insertFact(db, { content: "a", domain: "general", source_type: "explicit" });
    const b = insertFact(db, { content: "b", domain: "general", source_type: "explicit" });
    insertEmbeddings(db, [{ fact_id: a.id, vector: vec(1, 0) }], "model-a", 2);
    insertEmbeddings(db, [{ fact_id: b.id, vector: vec(1, 0, 0) }], "model-b", 3);

    expect(getStats(db).embeddings).toEqual([
      { model: "model-a", dimensions: 2, count: 1 },
      { model: "model-b", dimensions: 3, count: 1 },
    ]);
  });

  it("counts only currently-true facts, so coverage compares like with like", () => {
    // An embedding outlives its fact's currency: the row stays when the fact is
    // superseded. Counting it would let coverage exceed the fact count and read
    // as over 100% — the ratio is only meaningful against the same population.
    const live = insertFact(db, { content: "live", domain: "general", source_type: "explicit" });
    const old = insertFact(db, { content: "old", domain: "general", source_type: "explicit" });
    insertEmbeddings(
      db,
      [
        { fact_id: live.id, vector: vec(1, 0) },
        { fact_id: old.id, vector: vec(0, 1) },
      ],
      "m",
      2,
    );
    db.prepare(`UPDATE facts SET status = 'superseded', is_latest = 0 WHERE id = ?`).run(old.id);

    const stats = getStats(db);
    expect(stats.facts.active_latest).toBe(1);
    expect(stats.embeddings).toEqual([{ model: "m", dimensions: 2, count: 1 }]);
  });
});
