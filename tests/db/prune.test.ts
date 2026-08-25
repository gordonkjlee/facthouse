/**
 * Reclaiming unreachable raw events.
 *
 * Every assertion here is about something that must NOT be deleted. That is the
 * asymmetry of the operation: keeping an event too long costs disk, deleting one
 * too early costs data that cannot be recovered, and none of the three readers
 * that depend on these rows would raise if their events vanished — extraction
 * would quietly get worse, provenance would dangle, and search would be
 * unaffected, so nothing would look wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const dbMod = await import("../../src/db/index.js");
const { applySchema } = await import("../../src/db/schema.js");
const { prunableEvents, pruneEvents } = await import("../../src/db/prune.js");
const { createSession, insertEvent } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { insertFact } = await import("../../src/db/facts.js");

let db: Db;
let s1: string;
let s2: string;

beforeEach(() => {
  db = dbMod.openDatabase(":memory:");
  applySchema(db);
  s1 = createSession(db, { source_tool: "test", project: null }).id;
});

afterEach(() => dbMod.closeDatabase(db));

/**
 * Add an event through the production insert path.
 *
 * Not hand-written SQL: the sequence number, the session columns and the
 * defaults are all decided by `insertEvent`, and a fixture that sets them
 * itself would be testing the prune rule against rows the system never
 * actually writes.
 */
function addEvent(session?: string, content = "some tool output"): string {
  return insertEvent(db, {
    mcp_session_id: session ?? s1,
    event_type: "tool_result",
    role: "tool",
    content,
  }).id;
}

/** Move the extraction watermark to cover everything logged so far. */
function markAllRead() {
  const seq = db.prepare(`SELECT COALESCE(MAX(sequence), 0) v FROM session_events`).get()
    .v as number;
  db.prepare(
    `INSERT INTO consolidations
       (id, session_id, facts_in, facts_graduated, facts_rejected, entities_created,
        entities_linked, supersessions, summary, open_threads, last_event_sequence, created_at)
     VALUES (?, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, datetime('now'))`,
  ).run(`c${seq}`, seq);
}

function citeAsProvenance(eventId: string) {
  const sf = insertSessionFact(db, {
    session_id: s1,
    content: "Alex prefers dark roast coffee",
    source_origin: "inferred",
  });
  db.prepare(
    `INSERT INTO session_fact_sources (session_fact_id, event_id, relevance, extraction_type)
     VALUES (?, ?, 1.0, 'primary')`,
  ).run(sf.id, eventId);
}

const remaining = () =>
  db.prepare(`SELECT COUNT(*) c FROM session_events`).get().c as number;

describe("what prune refuses to remove", () => {
  it("keeps events extraction has not read yet", () => {
    // Ahead of the watermark an event is still input. Deleting it would discard
    // conversation that was never examined — the same class of loss as advancing
    // a watermark past events a failed extractor never saw.
    for (let i = 0; i < 5; i++) addEvent();
    // No consolidation row at all: the watermark is 0.
    expect(prunableEvents(db, 0).events).toBe(0);
  });

  it("keeps an event a fact's provenance points at, however old", () => {
    const cited = addEvent(undefined, "the sentence a fact came from");
    for (let i = 0; i < 5; i++) addEvent();
    markAllRead();
    citeAsProvenance(cited);

    pruneEvents(db, 0);

    const survivors = db.prepare(`SELECT id FROM session_events`).all().map((r) => r.id);
    expect(survivors).toEqual([cited]);
  });

  it("keeps the most recent events of a session as working memory", () => {
    // The condition that is invisible unless you read the extraction path:
    // consolidation re-reads already-read events from the same session for
    // pronoun resolution. Pruning them degrades every future extraction in that
    // session and raises nothing.
    for (let i = 0; i < 10; i++) addEvent();
    markAllRead();

    expect(prunableEvents(db, 4).events).toBe(6);
    expect(prunableEvents(db, 10).events).toBe(0);
    // The guard is what makes the difference — without it, all ten go.
    expect(prunableEvents(db, 0).events).toBe(10);
  });

  it("counts the working-memory window per session, not across the store", () => {
    // Two sessions of 6 events each, keeping 4. A global window would spare 4
    // events in total and delete 8; a per-session one spares 4 each.
    for (let i = 0; i < 6; i++) addEvent();
    s2 = createSession(db, { source_tool: "test", project: null }).id;
    for (let i = 0; i < 6; i++) addEvent(s2);
    markAllRead();

    expect(prunableEvents(db, 4).events).toBe(4);
  });

  it("partitions dual-id rows by client id, matching conversationRef", () => {
    // Pull writes client only. MCP log_event with OPENMEMORY_CLIENT_SESSION
    // writes both. They are the same Claude chat, so they share a working-memory
    // window. mcp-first COALESCE would split them: pull by client, MCP by
    // connection. Client-first keeps them together.
    const mcp = s1;
    for (let i = 0; i < 6; i++) {
      insertEvent(db, {
        client_session_id: "sess-aaa",
        event_type: "message",
        role: "user",
        content: "pulled from jsonl",
      });
    }
    for (let i = 0; i < 6; i++) {
      insertEvent(db, {
        mcp_session_id: mcp,
        client_session_id: "sess-aaa",
        event_type: "message",
        role: "user",
        content: "logged on the mcp connection",
      });
    }
    markAllRead();

    // One conversation of 12, keep 4 → prune 8. Two partitions of 6 would prune 4.
    expect(prunableEvents(db, 4).events).toBe(8);
  });
});

describe("what prune does remove", () => {
  it("removes read, uncited, out-of-window events and reports the bytes", () => {
    for (let i = 0; i < 8; i++) addEvent(undefined, "x".repeat(100));
    markAllRead();

    const result = pruneEvents(db, 3);

    expect(result.events).toBe(5);
    expect(result.bytes).toBe(500);
    expect(remaining()).toBe(3);
  });

  it("reports exactly what it will delete", () => {
    // A dry run that disagrees with the apply is worse than no dry run, so both
    // read one definition of the rule. This is what catches them diverging.
    for (let i = 0; i < 9; i++) addEvent();
    markAllRead();

    const predicted = prunableEvents(db, 2);
    const actual = pruneEvents(db, 2);

    expect(actual).toEqual(predicted);
    expect(remaining()).toBe(9 - predicted.events);
  });

  it("leaves facts, entities and session_facts untouched", () => {
    // Pruning is about the raw layer only. If it ever reached the knowledge
    // layer that would be data loss, not housekeeping.
    const cited = addEvent();
    for (let i = 0; i < 5; i++) addEvent();
    markAllRead();
    citeAsProvenance(cited);
    insertFact(db, {
      content: "Alex prefers dark roast coffee",
      domain: "preferences",
      source_type: "explicit",
    });

    pruneEvents(db, 0);

    expect(db.prepare(`SELECT COUNT(*) c FROM facts`).get().c).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) c FROM session_facts`).get().c).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) c FROM session_fact_sources`).get().c).toBe(1);
  });

  it("is a no-op on an empty store rather than an error", () => {
    expect(pruneEvents(db, 50)).toEqual({ events: 0, bytes: 0 });
  });

  it("is idempotent", () => {
    for (let i = 0; i < 6; i++) addEvent();
    markAllRead();

    expect(pruneEvents(db, 2).events).toBe(4);
    // The second run must find nothing — if the rule were unstable it would
    // keep eating into the working-memory window on each invocation.
    expect(pruneEvents(db, 2).events).toBe(0);
    expect(remaining()).toBe(2);
  });
});
