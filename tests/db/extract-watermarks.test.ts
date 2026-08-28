/**
 * Per-conversation extract clock. Synthetic names only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const {
  conversationExtractThrough,
  extractWatermark,
  unexaminedEventCount,
  setConversationExtractThrough,
  seedExtractWatermarksFromConsolidations,
  advanceExtractMarksToCurrentMax,
} = await import("../../src/db/extract-watermarks.js");
const { pruneEvents } = await import("../../src/db/prune.js");

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("extract watermark helper", () => {
  it("treats a missing row as 0", async () => {
    expect(
      await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" }),
    ).toBe(0);
    expect(await extractWatermark(db)).toBe(0);
    expect(await unexaminedEventCount(db)).toBe(0);
  });

  it("uses MIN of unexamined sequences, not MAX of per-id marks", async () => {
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
    await setConversationExtractThrough(db, { kind: "client", id: "sess-aaa" }, 3);
    expect(await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" })).toBe(3);
    expect(await extractWatermark(db)).toBe(1);
    expect(await unexaminedEventCount(db)).toBe(1);
    await pruneEvents(db, 0);
    const left = (
      (await db
        .prepare(`SELECT sequence FROM session_events ORDER BY sequence ASC`)
        .all()) as Array<{ sequence: number }>
    ).map((r) => r.sequence);
    expect(left).toEqual([2, 3]);
  });

  it("does not move a mark backwards", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex prefers oat milk at Acme.",
    });
    await setConversationExtractThrough(db, { kind: "client", id: "sess-aaa" }, 1);
    await setConversationExtractThrough(db, { kind: "client", id: "sess-aaa" }, 0);
    expect(await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" })).toBe(1);
  });

  it("seeds per-id marks from the old consolidations MAX so a finished store is not re-extracted", async () => {
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
    await db
      .prepare(
        `INSERT INTO consolidations
           (id, session_id, facts_in, facts_graduated, facts_rejected,
            entities_created, entities_linked, supersessions,
            summary, open_threads, last_event_sequence, created_at)
         VALUES ('c-old', NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, 2, ?)`,
      )
      .run(new Date().toISOString());
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "Alex also prefers dark roast.",
    });
    await db.prepare(`DELETE FROM extract_watermarks`).run();
    await seedExtractWatermarksFromConsolidations(db);
    expect(await conversationExtractThrough(db, { kind: "client", id: "sess-aaa" })).toBe(1);
    expect(await conversationExtractThrough(db, { kind: "client", id: "sess-bbb" })).toBe(2);
    expect(await unexaminedEventCount(db)).toBe(1);
    expect(await extractWatermark(db)).toBe(2);
  });

  it("policy-off decline covers every conversation's current max", async () => {
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
    await advanceExtractMarksToCurrentMax(db);
    expect(await unexaminedEventCount(db)).toBe(0);
    expect(await extractWatermark(db)).toBe(2);
  });
});

describe("live extract clock is not MAX(consolidations.last_event_sequence)", () => {
  it("does not use that query in src except the v19 seed", () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!p.endsWith(".ts")) continue;
        const rel = path.relative(srcRoot, p).replaceAll("\\", "/");
        if (rel === "db/extract-watermarks.ts") continue;
        const text = readFileSync(p, "utf8");
        if (/MAX\s*\(\s*last_event_sequence\s*\)/i.test(text)) hits.push(rel);
      }
    };
    walk(srcRoot);
    expect(hits).toEqual([]);
  });
});
