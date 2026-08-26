import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession, insertEvent, getSession } = await import("../../src/db/sessions.js");
const {
  insertSessionFact,
  computeContentHash,
  getSessionFacts,
  getUnconsolidatedFacts,
  getUnconsolidatedSessionFacts,
  claimForConsolidation,
  getClaimedFacts,
  linkFactSource,
  getFactSources,
  speakerNameOf,
} = await import("../../src/db/session-facts.js");

let db: Db;
let sessionId: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
  const session = await createSession(db, { source_tool: "test", project: null });
  sessionId = session.id;
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("speakerNameOf", () => {
  it("trims display names and treats empty as missing", () => {
    expect(speakerNameOf("Alex")).toBe("Alex");
    expect(speakerNameOf("  Alex Rivera  ")).toBe("Alex Rivera");
    expect(speakerNameOf("")).toBeNull();
    expect(speakerNameOf("   ")).toBeNull();
    expect(speakerNameOf(null)).toBeNull();
    expect(speakerNameOf(undefined)).toBeNull();
    expect(speakerNameOf(1)).toBeNull();
  });
});

describe("session facts", () => {
  it("inserts a session fact and returns it with all fields", async () => {
    const fact = await insertSessionFact(db, {
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
    expect(fact!.speaker).toBeNull();
    expect(fact!.speaker_role).toBeNull();
  });

  it("stores a named speaker when given", async () => {
    const fact = await insertSessionFact(db, {
      session_id: sessionId,
      content: "Bookings are the grain of the orders mart at Acme.",
      speaker: "  Alex  ",
    });
    expect(fact!.speaker).toBe("Alex");
  });

  it("computes content_hash automatically", async () => {
    const fact = await insertSessionFact(db, {
      session_id: sessionId,
      content: "User prefers dark mode",
    });

    const expectedHash = computeContentHash("User prefers dark mode");
    expect(fact).not.toBeNull();
    expect(fact!.content_hash).toBe(expectedHash);
    expect(fact!.content_hash).toHaveLength(64); // SHA-256 hex
  });

  it("rejects exact duplicate content within the same session (returns null)", async () => {
    const first = await insertSessionFact(db, {
      session_id: sessionId,
      content: "Duplicate fact",
    });
    expect(first).not.toBeNull();

    const second = await insertSessionFact(db, {
      session_id: sessionId,
      content: "Duplicate fact",
    });
    expect(second).toBeNull();
  });

  it("allows same content in different sessions", async () => {
    const session2 = await createSession(db, { source_tool: "test", project: null });

    const first = await insertSessionFact(db, {
      session_id: sessionId,
      content: "Shared fact",
    });
    const second = await insertSessionFact(db, {
      session_id: session2.id,
      content: "Shared fact",
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
  });

  it("getSessionFacts returns facts ordered by created_at", async () => {
    await insertSessionFact(db, { session_id: sessionId, content: "First fact" });
    await insertSessionFact(db, { session_id: sessionId, content: "Second fact" });
    await insertSessionFact(db, { session_id: sessionId, content: "Third fact" });

    const facts = await getSessionFacts(db, sessionId);
    expect(facts).toHaveLength(3);
    expect(facts[0].content).toBe("First fact");
    expect(facts[1].content).toBe("Second fact");
    expect(facts[2].content).toBe("Third fact");
  });

  it("getUnconsolidatedFacts returns only unclaimed facts", async () => {
    await insertSessionFact(db, { session_id: sessionId, content: "Unclaimed A" });
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "Claimed B",
      consolidation_id: "run-1",
    });
    await insertSessionFact(db, { session_id: sessionId, content: "Unclaimed C" });

    const unclaimed = await getUnconsolidatedFacts(db);
    expect(unclaimed).toHaveLength(2);
    expect(unclaimed.map((f: any) => f.content).sort()).toEqual([
      "Unclaimed A",
      "Unclaimed C",
    ]);
  });

  it("getUnconsolidatedSessionFacts filters by session AND unclaimed, ordered by created_at ASC", async () => {
    const session2 = await createSession(db, { source_tool: "test", project: null });

    await insertSessionFact(db, { session_id: sessionId, content: "First A" });
    await new Promise((r) => setTimeout(r, 10));
    await insertSessionFact(db, { session_id: sessionId, content: "Second B" });
    await insertSessionFact(db, {
      session_id: sessionId,
      content: "Claimed C",
      consolidation_id: "run-1",
    });
    // Fact in a different session — must not appear
    await insertSessionFact(db, { session_id: session2.id, content: "Other session" });

    const result = await getUnconsolidatedSessionFacts(db, sessionId);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("First A");
    expect(result[1].content).toBe("Second B");
  });

  it("claimForConsolidation atomically claims unclaimed facts and returns count", async () => {
    await insertSessionFact(db, { session_id: sessionId, content: "Fact 1" });
    await insertSessionFact(db, { session_id: sessionId, content: "Fact 2" });
    await insertSessionFact(db, { session_id: sessionId, content: "Fact 3" });

    const claimed = await claimForConsolidation(db, "consolidation-abc");
    expect(claimed).toBe(3);

    // All facts now have the consolidation_id
    const unclaimed = await getUnconsolidatedFacts(db);
    expect(unclaimed).toHaveLength(0);
  });

  it("getClaimedFacts returns only facts with matching consolidation_id", async () => {
    await insertSessionFact(db, { session_id: sessionId, content: "Batch A" });
    await insertSessionFact(db, { session_id: sessionId, content: "Batch B" });
    await claimForConsolidation(db, "run-1");

    await insertSessionFact(db, { session_id: sessionId, content: "Batch C" });
    await claimForConsolidation(db, "run-2");

    const run1Facts = await getClaimedFacts(db, "run-1");
    expect(run1Facts).toHaveLength(2);
    expect(run1Facts.map((f: any) => f.content).sort()).toEqual([
      "Batch A",
      "Batch B",
    ]);

    const run2Facts = await getClaimedFacts(db, "run-2");
    expect(run2Facts).toHaveLength(1);
    expect(run2Facts[0].content).toBe("Batch C");
  });

});

describe("session fact sources (provenance)", () => {
  let factId: string;
  let eventId: string;

  beforeEach(async () => {
    const fact = await insertSessionFact(db, {
      session_id: sessionId,
      content: "Fact for provenance",
    });
    factId = fact!.id;

    const event = await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "I prefer dark mode",
    });
    eventId = event.id;
  });

  it("linkFactSource creates a provenance link", async () => {
    await linkFactSource(db, {
      session_fact_id: factId,
      event_id: eventId,
      relevance: 0.95,
      extraction_type: "primary",
    });

    const sources = await getFactSources(db, factId);
    expect(sources).toHaveLength(1);
    expect(sources[0].session_fact_id).toBe(factId);
    expect(sources[0].event_id).toBe(eventId);
    expect(sources[0].relevance).toBe(0.95);
    expect(sources[0].extraction_type).toBe("primary");
  });

  it("getFactSources returns all sources for a fact", async () => {
    const event2 = await insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "assistant",
      content: "Noted, dark mode preference saved",
    });

    await linkFactSource(db, {
      session_fact_id: factId,
      event_id: eventId,
      relevance: 1.0,
      extraction_type: "primary",
    });
    await linkFactSource(db, {
      session_fact_id: factId,
      event_id: event2.id,
      relevance: 0.5,
      extraction_type: "corroborating",
    });

    const sources = await getFactSources(db, factId);
    expect(sources).toHaveLength(2);
  });
});
