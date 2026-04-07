import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

// better-sqlite3 requires native bindings — test actual constructor, not just import.
let canLoadSqlite = false;
try {
  const Db = (await import("better-sqlite3")).default;
  const probe = new Db(":memory:");
  probe.close();
  canLoadSqlite = true;
} catch {
  // Native bindings not compiled (e.g. missing Visual Studio build tools on Windows).
}

const { openDatabase, closeDatabase } = canLoadSqlite
  ? await import("../../src/db/connection.js")
  : ({} as any);
const { applySchema } = canLoadSqlite
  ? await import("../../src/db/schema.js")
  : ({} as any);
const { createSession, insertEvent, getSession } = canLoadSqlite
  ? await import("../../src/db/sessions.js")
  : ({} as any);
const {
  insertSessionFact,
  computeContentHash,
  getSessionFacts,
  getUnconsolidatedFacts,
  claimForConsolidation,
  getClaimedFacts,
  linkFactSource,
  getFactSources,
} = canLoadSqlite
  ? await import("../../src/db/session-facts.js")
  : ({} as any);

let db: Database.Database;
let sessionId: string;

beforeEach(() => {
  if (!canLoadSqlite) return;
  db = openDatabase(":memory:");
  applySchema(db);
  const session = createSession(db, { source_tool: "test", project: null });
  sessionId = session.id;
});

afterEach(() => {
  if (!canLoadSqlite) return;
  closeDatabase(db);
});

describe.skipIf(!canLoadSqlite)("session facts", () => {
  it("inserts a session fact and returns it with all fields", () => {
    const fact = insertSessionFact(db, {
      session_id: sessionId,
      content: "User prefers dark mode",
      source_origin: "explicit",
      domain_hint: "preferences",
      confidence: 0.9,
      importance: 0.7,
      source_tool: "claude-code",
      capture_context: "settings discussion",
    });

    expect(fact).not.toBeNull();
    expect(fact!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(fact!.session_id).toBe(sessionId);
    expect(fact!.content).toBe("User prefers dark mode");
    expect(fact!.source_origin).toBe("explicit");
    expect(fact!.domain_hint).toBe("preferences");
    expect(fact!.confidence).toBe(0.9);
    expect(fact!.importance).toBe(0.7);
    expect(fact!.source_tool).toBe("claude-code");
    expect(fact!.capture_context).toBe("settings discussion");
    expect(fact!.consolidation_id).toBeNull();
    expect(fact!.created_at).toBeTruthy();
  });

  it("computes content_hash automatically", () => {
    const fact = insertSessionFact(db, {
      session_id: sessionId,
      content: "User prefers dark mode",
    });

    const expectedHash = computeContentHash("User prefers dark mode");
    expect(fact).not.toBeNull();
    expect(fact!.content_hash).toBe(expectedHash);
    expect(fact!.content_hash).toHaveLength(64); // SHA-256 hex
  });

  it("rejects exact duplicate content within the same session (returns null)", () => {
    const first = insertSessionFact(db, {
      session_id: sessionId,
      content: "Duplicate fact",
    });
    expect(first).not.toBeNull();

    const second = insertSessionFact(db, {
      session_id: sessionId,
      content: "Duplicate fact",
    });
    expect(second).toBeNull();
  });

  it("allows same content in different sessions", () => {
    const session2 = createSession(db, { source_tool: "test", project: null });

    const first = insertSessionFact(db, {
      session_id: sessionId,
      content: "Shared fact",
    });
    const second = insertSessionFact(db, {
      session_id: session2.id,
      content: "Shared fact",
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
  });

  it("getSessionFacts returns facts ordered by created_at", () => {
    insertSessionFact(db, { session_id: sessionId, content: "First fact" });
    insertSessionFact(db, { session_id: sessionId, content: "Second fact" });
    insertSessionFact(db, { session_id: sessionId, content: "Third fact" });

    const facts = getSessionFacts(db, sessionId);
    expect(facts).toHaveLength(3);
    expect(facts[0].content).toBe("First fact");
    expect(facts[1].content).toBe("Second fact");
    expect(facts[2].content).toBe("Third fact");
  });

  it("getUnconsolidatedFacts returns only unclaimed facts", () => {
    insertSessionFact(db, { session_id: sessionId, content: "Unclaimed A" });
    insertSessionFact(db, {
      session_id: sessionId,
      content: "Claimed B",
      consolidation_id: "run-1",
    });
    insertSessionFact(db, { session_id: sessionId, content: "Unclaimed C" });

    const unclaimed = getUnconsolidatedFacts(db);
    expect(unclaimed).toHaveLength(2);
    expect(unclaimed.map((f: any) => f.content).sort()).toEqual([
      "Unclaimed A",
      "Unclaimed C",
    ]);
  });

  it("claimForConsolidation atomically claims unclaimed facts and returns count", () => {
    insertSessionFact(db, { session_id: sessionId, content: "Fact 1" });
    insertSessionFact(db, { session_id: sessionId, content: "Fact 2" });
    insertSessionFact(db, { session_id: sessionId, content: "Fact 3" });

    const claimed = claimForConsolidation(db, "consolidation-abc");
    expect(claimed).toBe(3);

    // All facts now have the consolidation_id
    const unclaimed = getUnconsolidatedFacts(db);
    expect(unclaimed).toHaveLength(0);
  });

  it("getClaimedFacts returns only facts with matching consolidation_id", () => {
    insertSessionFact(db, { session_id: sessionId, content: "Batch A" });
    insertSessionFact(db, { session_id: sessionId, content: "Batch B" });
    claimForConsolidation(db, "run-1");

    insertSessionFact(db, { session_id: sessionId, content: "Batch C" });
    claimForConsolidation(db, "run-2");

    const run1Facts = getClaimedFacts(db, "run-1");
    expect(run1Facts).toHaveLength(2);
    expect(run1Facts.map((f: any) => f.content).sort()).toEqual([
      "Batch A",
      "Batch B",
    ]);

    const run2Facts = getClaimedFacts(db, "run-2");
    expect(run2Facts).toHaveLength(1);
    expect(run2Facts[0].content).toBe("Batch C");
  });

});

describe.skipIf(!canLoadSqlite)("session fact sources (provenance)", () => {
  let factId: string;
  let eventId: string;

  beforeEach(() => {
    const fact = insertSessionFact(db, {
      session_id: sessionId,
      content: "Fact for provenance",
    });
    factId = fact!.id;

    const event = insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "I prefer dark mode",
    });
    eventId = event.id;
  });

  it("linkFactSource creates a provenance link", () => {
    linkFactSource(db, {
      session_fact_id: factId,
      event_id: eventId,
      relevance: 0.95,
      extraction_type: "primary",
    });

    const sources = getFactSources(db, factId);
    expect(sources).toHaveLength(1);
    expect(sources[0].session_fact_id).toBe(factId);
    expect(sources[0].event_id).toBe(eventId);
    expect(sources[0].relevance).toBe(0.95);
    expect(sources[0].extraction_type).toBe("primary");
  });

  it("getFactSources returns all sources for a fact", () => {
    const event2 = insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "assistant",
      content: "Noted, dark mode preference saved",
    });

    linkFactSource(db, {
      session_fact_id: factId,
      event_id: eventId,
      relevance: 1.0,
      extraction_type: "primary",
    });
    linkFactSource(db, {
      session_fact_id: factId,
      event_id: event2.id,
      relevance: 0.5,
      extraction_type: "corroborating",
    });

    const sources = getFactSources(db, factId);
    expect(sources).toHaveLength(2);
  });
});
