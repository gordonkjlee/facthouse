/**
 * Episode slices: keyword-on-D when graduated knowledge is empty.
 * Synthetic fixtures only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import {
  EPISODE_CONTENT_CHARS,
  EPISODE_RADIUS,
  EPISODE_REFINEMENT,
  searchEpisodes,
} from "../../src/search/episodes.js";

const dbMod = await import("../../src/db/index.js");
const searchMod = await import("../../src/search/index.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const { sanitiseFtsQuery } = await import("../../src/db/facts.js");
const { pruneEvents } = await import("../../src/db/prune.js");

let db: Db;

beforeEach(() => {
  db = dbMod.openDatabase(":memory:");
  dbMod.applySchema(db);
});

afterEach(() => {
  dbMod.closeDatabase(db);
});

function user(sessionId: string, content: string) {
  return insertEvent(db, {
    client_session_id: sessionId,
    event_type: "message",
    role: "user",
    content,
  });
}

describe("searchEpisodes", () => {
  it("inserting a null-content event does not break the FTS index", () => {
    insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "assistant",
      content: null,
    });
    user("sess-aaa", "Alex keeps a brass kaleidoscope on the desk at Acme.");
    expect(searchEpisodes(db, sanitiseFtsQuery("kaleidoscope"))).toHaveLength(1);
  });

  it("returns a window around the hit, not only the matching line", () => {
    user("sess-aaa", "lead-in about the weather");
    const hit = user("sess-aaa", "Alex keeps a brass kaleidoscope on the desk at Acme.");
    user("sess-aaa", "and then we moved on");
    const q = sanitiseFtsQuery("kaleidoscope");
    const slices = searchEpisodes(db, q);
    expect(slices).toHaveLength(1);
    expect(slices[0].conversation_id).toBe("sess-aaa");
    expect(slices[0].events.length).toBeGreaterThanOrEqual(3);
    const matched = slices[0].events.filter((e) => e.matched);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe(hit.id);
    expect(slices[0].events.some((e) => e.content?.includes("weather"))).toBe(true);
    expect(slices[0].events.some((e) => e.content?.includes("moved on"))).toBe(true);
    expect(EPISODE_RADIUS).toBe(2);
  });

  it("keeps two conversations in separate slices", () => {
    user("sess-aaa", "Alex keeps a brass kaleidoscope at Acme.");
    user("sess-bbb", "Robin mentioned a kaleidoscope too.");
    const slices = searchEpisodes(db, sanitiseFtsQuery("kaleidoscope"));
    expect(slices).toHaveLength(2);
    const ids = slices.map((s) => s.conversation_id).sort();
    expect(ids).toEqual(["sess-aaa", "sess-bbb"]);
  });

  it("truncates a long event rather than returning the whole dump", () => {
    user("sess-aaa", `${"kaleidoscope ".repeat(80)}end`);
    const slices = searchEpisodes(db, sanitiseFtsQuery("kaleidoscope"));
    expect(slices[0].events[0].content!.length).toBe(EPISODE_CONTENT_CHARS);
    expect(slices[0].events[0].content).not.toContain("end");
  });

  it("does not hit a pruned event", () => {
    const hit = user("sess-aaa", "Alex keeps a brass kaleidoscope on the desk at Acme.");
    expect(searchEpisodes(db, sanitiseFtsQuery("kaleidoscope")).length).toBe(1);
    // Watermark past the event so prune's "already extracted" condition holds,
    // and no fact cites it.
    db.prepare(
      `INSERT INTO consolidations
         (id, session_id, facts_in, facts_graduated, facts_rejected,
          entities_created, entities_linked, supersessions,
          summary, open_threads, last_event_sequence, created_at)
       VALUES ('c1', 'sess-aaa', 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?)`,
    ).run(hit.sequence, new Date().toISOString());
    pruneEvents(db, 0);
    expect(searchEpisodes(db, sanitiseFtsQuery("kaleidoscope"))).toEqual([]);
  });
});

describe("hybridSearch fills episodes only when K is empty", () => {
  it("returns an episode slice for a pulled line that never graduated", () => {
    user("sess-aaa", "Alex keeps a brass kaleidoscope on the desk at Acme.");
    const result = searchMod.hybridSearch(db, "kaleidoscope");
    expect(result.results).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0].events.some((e) => e.matched)).toBe(true);
    expect(result.suggested_refinement).toBe(EPISODE_REFINEMENT);
    expect(result.coverage_estimate).toBe(0);
  });

  it("does not search D when a graduated fact already matched", () => {
    user("sess-aaa", "Alex keeps a brass kaleidoscope on the desk at Acme.");
    dbMod.insertFact(db, {
      content: "Alex keeps a brass kaleidoscope on the desk at Acme.",
      domain: "preferences",
      source_type: "conversation",
    });
    const result = searchMod.hybridSearch(db, "kaleidoscope");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.episodes).toEqual([]);
  });

  it("returns an empty episodes list rather than omitting the field", () => {
    const result = searchMod.hybridSearch(db, "kaleidoscope");
    expect(result.episodes).toEqual([]);
  });
});
