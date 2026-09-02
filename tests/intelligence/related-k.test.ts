/**
 * Related-K retrieval for D→I. Synthetic only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { relatedFactsForExtract } from "../../src/intelligence/related-k.js";
import { EXTRACT_RELATED_K_CAP } from "../../src/intelligence/extract-prompt.js";
import type { SessionEvent } from "../../src/types/data.js";

const dbMod = await import("../../src/db/index.js");

let db: Db;

beforeEach(async () => {
  db = dbMod.openDatabase(":memory:");
  await dbMod.applySchema(db);
});

afterEach(async () => {
  await dbMod.closeDatabase(db);
});

function event(content: string): SessionEvent {
  return {
    id: "e1",
    mcp_session_id: null,
    client_session_id: "sess-aaa",
    sequence: 1,
    event_type: "message",
    role: "user",
    content_type: "text",
    content,
    content_ref: null,
    metadata: null,
    created_at: new Date().toISOString(),
    occurred_at: null,
  };
}

describe("relatedFactsForExtract", () => {
  it("returns nothing when there are no events or no facts", async () => {
    expect(await relatedFactsForExtract(db, [])).toEqual([]);
    expect(
      await relatedFactsForExtract(db, [event("Alex prefers coffee.")]),
    ).toEqual([]);
  });

  it("returns related integrated facts and not the whole store", async () => {
    await dbMod.insertFact(db, {
      content: "Alex prefers coffee.",
      domain: "preferences",
      source_type: "conversation",
    });
    await dbMod.insertFact(db, {
      content: "Robin keeps a brass kaleidoscope on the desk at Acme.",
      domain: "preferences",
      source_type: "conversation",
    });
    const related = await relatedFactsForExtract(db, [
      event("Alex no longer drinks coffee."),
    ]);
    expect(related.some((f) => f.content.includes("coffee"))).toBe(true);
    expect(related.some((f) => f.content.includes("kaleidoscope"))).toBe(false);
    expect(related.length).toBeLessThanOrEqual(EXTRACT_RELATED_K_CAP);
  });

  it("caps even when many facts share a token", async () => {
    for (let i = 0; i < 20; i++) {
      await dbMod.insertFact(db, {
        content: `Alex likes coffee blend number ${i} at Acme.`,
        domain: "preferences",
        source_type: "conversation",
      });
    }
    const related = await relatedFactsForExtract(db, [
      event("Alex ordered coffee at Acme."),
    ]);
    expect(related.length).toBe(EXTRACT_RELATED_K_CAP);
  });
});
