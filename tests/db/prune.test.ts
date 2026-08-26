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

beforeEach(async () => {
  db = dbMod.openDatabase(":memory:");
  await applySchema(db);
  s1 = (await createSession(db, { source_tool: "test", project: null })).id;
});

afterEach(async () => {
  await dbMod.closeDatabase(db);
});

/**
 * Add an event through the production insert path.
 *
 * Not hand-written SQL: the sequence number, the session columns and the
 * defaults are all decided by `insertEvent`, and a fixture that sets them
 * itself would be testing the prune rule against rows the system never
 * actually writes.
 */
async function addEvent(session?: string, content = "some tool output"): Promise<string> {
  return (await insertEvent(db, {
    mcp_session_id: session ?? s1,
    event_type: "tool_result",
    role: "tool",
    content,
  })).id;
}

/** Move the extraction watermark to cover everything logged so far. */
async function markAllRead() {
  const seq = ((await db.prepare(`SELECT COALESCE(MAX(sequence), 0) v FROM session_events`).get()) as { v: number }).v;
  await db.prepare(
    `INSERT INTO consolidations
       (id, session_id, facts_in, facts_graduated, facts_rejected, entities_created,
        entities_linked, supersessions, summary, open_threads, last_event_sequence, created_at)
     VALUES (?, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, datetime('now'))`,
  ).run(`c${seq}`, seq);
}

async function citeAsProvenance(eventId: string) {
  const sf = await insertSessionFact(db, {
    session_id: s1,
    content: "Alex prefers dark roast coffee",
    source_origin: "inferred",
  });
  await db.prepare(
    `INSERT INTO session_fact_sources (session_fact_id, event_id, relevance, extraction_type)
     VALUES (?, ?, 1.0, 'primary')`,
  ).run(sf.id, eventId);
}

const remaining = async () =>
  ((await db.prepare(`SELECT COUNT(*) c FROM session_events`).get()) as { c: number }).c;

describe("what prune refuses to remove", () => {
  it("keeps events extraction has not read yet", async () => {
    // Ahead of the watermark an event is still input. Deleting it would discard
    // conversation that was never examined — the same class of loss as advancing
    // a watermark past events a failed extractor never saw.
    for (let i = 0; i < 5; i++) await addEvent();
    // No consolidation row at all: the watermark is 0.
    expect((await prunableEvents(db, 0)).events).toBe(0);
  });

  it("keeps an event a fact's provenance points at, however old", async () => {
    const cited = await addEvent(undefined, "the sentence a fact came from");
    for (let i = 0; i < 5; i++) await addEvent();
    await markAllRead();
    await citeAsProvenance(cited);

    await pruneEvents(db, 0);

    const survivors = ((await db.prepare(`SELECT id FROM session_events`).all()) as Array<{ id: string }>).map((r) => r.id);
    expect(survivors).toEqual([cited]);
  });

  it("keeps the most recent events of a session as working memory", async () => {
    // Reachable recent D for this session: reread and the evidence prefix
    // both read already-extracted events. Pruning them silently degrades
    // forgetfulness reread.
    for (let i = 0; i < 10; i++) await addEvent();
    await markAllRead();

    expect((await prunableEvents(db, 4)).events).toBe(6);
    expect((await prunableEvents(db, 10)).events).toBe(0);
    // The guard is what makes the difference — without it, all ten go.
    expect((await prunableEvents(db, 0)).events).toBe(10);
  });

  it("counts the working-memory window per session, not across the store", async () => {
    // Two sessions of 6 events each, keeping 4. A global window would spare 4
    // events in total and delete 8; a per-session one spares 4 each.
    for (let i = 0; i < 6; i++) await addEvent();
    s2 = (await createSession(db, { source_tool: "test", project: null })).id;
    for (let i = 0; i < 6; i++) await addEvent(s2);
    await markAllRead();

    expect((await prunableEvents(db, 4)).events).toBe(4);
  });

  it("partitions dual-id rows by client id, matching conversationRef", async () => {
    // Pull writes client only. MCP log_event with OPENMEMORY_CLIENT_SESSION
    // writes both. They are the same Claude chat, so they share a working-memory
    // window. mcp-first COALESCE would split them: pull by client, MCP by
    // connection. Client-first keeps them together.
    const mcp = s1;
    for (let i = 0; i < 6; i++) {
      await insertEvent(db, {
        client_session_id: "sess-aaa",
        event_type: "message",
        role: "user",
        content: "pulled from jsonl",
      });
    }
    for (let i = 0; i < 6; i++) {
      await insertEvent(db, {
        mcp_session_id: mcp,
        client_session_id: "sess-aaa",
        event_type: "message",
        role: "user",
        content: "logged on the mcp connection",
      });
    }
    await markAllRead();

    // One conversation of 12, keep 4 → prune 8. Two partitions of 6 would prune 4.
    expect((await prunableEvents(db, 4)).events).toBe(8);
  });
});

describe("what prune does remove", () => {
  it("removes read, uncited, out-of-window events and reports the bytes", async () => {
    for (let i = 0; i < 8; i++) await addEvent(undefined, "x".repeat(100));
    await markAllRead();

    const result = await pruneEvents(db, 3);

    expect(result.events).toBe(5);
    expect(result.bytes).toBe(500);
    expect(await remaining()).toBe(3);
  });

  it("reports exactly what it will delete", async () => {
    // A dry run that disagrees with the apply is worse than no dry run, so both
    // read one definition of the rule. This is what catches them diverging.
    for (let i = 0; i < 9; i++) await addEvent();
    await markAllRead();

    const predicted = await prunableEvents(db, 2);
    const actual = await pruneEvents(db, 2);

    expect(actual).toEqual(predicted);
    expect(await remaining()).toBe(9 - predicted.events);
  });

  it("leaves facts, entities and session_facts untouched", async () => {
    // Pruning is about the raw layer only. If it ever reached the knowledge
    // layer that would be data loss, not housekeeping.
    const cited = await addEvent();
    for (let i = 0; i < 5; i++) await addEvent();
    await markAllRead();
    await citeAsProvenance(cited);
    await insertFact(db, {
      content: "Alex prefers dark roast coffee",
      domain: "preferences",
      source_type: "explicit",
    });

    await pruneEvents(db, 0);

    expect(((await db.prepare(`SELECT COUNT(*) c FROM facts`).get()) as { c: number }).c).toBe(1);
    expect(((await db.prepare(`SELECT COUNT(*) c FROM session_facts`).get()) as { c: number }).c).toBe(1);
    expect(((await db.prepare(`SELECT COUNT(*) c FROM session_fact_sources`).get()) as { c: number }).c).toBe(1);
  });

  it("is a no-op on an empty store rather than an error", async () => {
    expect(await pruneEvents(db, 50)).toEqual({ events: 0, bytes: 0 });
  });

  it("is idempotent", async () => {
    for (let i = 0; i < 6; i++) await addEvent();
    await markAllRead();

    expect((await pruneEvents(db, 2)).events).toBe(4);
    // The second run must find nothing — if the rule were unstable it would
    // keep eating into the working-memory window on each invocation.
    expect((await pruneEvents(db, 2)).events).toBe(0);
    expect(await remaining()).toBe(2);
  });
});
