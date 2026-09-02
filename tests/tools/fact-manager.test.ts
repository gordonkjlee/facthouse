import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";


const dbMod = await import("../../src/db/index.js");
const sessionMod = await import("../../src/tools/session-manager.js");
const factMod = await import("../../src/tools/fact-manager.js");

let db: Db;

beforeEach(async () => {
  db = dbMod.openDatabase(":memory:");
  await dbMod.applySchema(db);
});

afterEach(async () => {
  await dbMod.closeDatabase(db);
});

describe("fact manager", () => {
  async function setup() {
    const sessionManager = sessionMod.createSessionManager(db);
    await sessionManager.startSession("test-client", "test-project");
    const factManager = factMod.createFactManager(db, sessionManager);
    return { sessionManager, factManager };
  }

  it("captures a fact and returns it with all fields", async () => {
    const { factManager } = await setup();

    const fact = await factManager.captureFact({
      content: "My name is Alex",
      domain_hint: "profile",
      confidence: 0.9,
      importance: 0.8,
      capture_context: "introduction",
    });

    expect(fact).not.toBeNull();
    expect(fact!.id).toBeTruthy();
    expect(fact!.content).toBe("My name is Alex");
    expect(fact!.content_hash).toBeTruthy();
    expect(fact!.source_origin).toBe("explicit");
    expect(fact!.domain_hint).toBe("profile");
    expect(fact!.confidence).toBe(0.9);
    expect(fact!.importance).toBe(0.8);
    expect(fact!.capture_context).toBe("introduction");
    expect(fact!.consolidation_id).toBeNull();
    expect(fact!.source_tool).toBe("test-client");
    expect(fact!.speaker_role).toBeNull();
    expect(fact!.speaker).toBeNull();
  });

  it("copies speaker_role from the source event", async () => {
    const { sessionManager, factManager } = await setup();
    const session = sessionManager.getActiveSession()!;
    const event = await dbMod.insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: "I prefer tea",
    });
    const fact = await factManager.captureFact({
      content: "The user prefers tea",
      source_event_id: event.id,
    });
    expect(fact!.speaker_role).toBe("user");
    expect(fact!.speaker).toBeNull();
  });

  it("copies a named speaker from the source event", async () => {
    const { sessionManager, factManager } = await setup();
    const session = sessionManager.getActiveSession()!;
    const event = await dbMod.insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: "The grain is bookings",
      speaker: "Alex",
    });
    const fact = await factManager.captureFact({
      content: "Bookings are the grain of the orders mart at Acme.",
      source_event_id: event.id,
    });
    expect(fact!.speaker).toBe("Alex");
    expect(fact!.speaker_role).toBe("user");
  });

  it("rejects exact duplicate content in the same session", async () => {
    const { factManager } = await setup();

    const first = await factManager.captureFact({ content: "I prefer tea" });
    const second = await factManager.captureFact({ content: "I prefer tea" });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("tags fact with active session ID", async () => {
    const { sessionManager, factManager } = await setup();

    const fact = await factManager.captureFact({ content: "fact one" });
    expect(fact!.session_id).toBe(sessionManager.getActiveSession()!.id);
  });

  it("throws if no active session", async () => {
    const sessionManager = sessionMod.createSessionManager(db);
    const factManager = factMod.createFactManager(db, sessionManager);

    await expect(factManager.captureFact({ content: "orphan" })).rejects.toThrow(
      "No active session",
    );
  });

  it("throws on empty or whitespace-only content", async () => {
    const { factManager } = await setup();

    await expect(factManager.captureFact({ content: "" })).rejects.toThrow("must not be empty");
    await expect(factManager.captureFact({ content: "   " })).rejects.toThrow("must not be empty");
  });

  it("does not guess importance from a domain hint at capture", async () => {
    // This previously asserted capture resolved a domain default from the
    // caller's domain_hint. Two things were wrong with that. Capture cannot know
    // a fact's domain — the classifier has not run, and a hint is a suggestion
    // the classifier may overrule. And writing a value here made the column
    // non-null, which short-circuited the resolution chain at integration
    // (`importance ?? importance_signal ?? domain default ?? baseline`), so a
    // provider's LLM judgement and the domain's real default both became
    // unreachable and every fact scored 0.5.
    //
    // A domain's importance now travels with the domain in the configured
    // vocabulary and is applied at integration. See
    // tests/intelligence/importance.test.ts.
    const sessionManager = sessionMod.createSessionManager(db);
    await sessionManager.startSession("test", null);
    const factManager = factMod.createFactManager(db, sessionManager, {});

    const fact = await factManager.captureFact({
      content: "Allergic to aspirin",
      domain_hint: "medical",
    });

    expect(fact!.importance).toBeNull();
  });

  it("explicit importance overrides domain default", async () => {
    const sessionManager = sessionMod.createSessionManager(db);
    await sessionManager.startSession("test", null);
    const factManager = factMod.createFactManager(db, sessionManager, {
    });

    const fact = await factManager.captureFact({
      content: "Takes vitamin D",
      domain_hint: "medical",
      importance: 0.3,
    });

    expect(fact!.importance).toBe(0.3);
  });

  it("leaves importance unscored at capture when nothing knows it yet", async () => {
    // This previously asserted 0.5 here, pinning *where* the default was
    // applied rather than *that* it was. Stamping it at capture made the column
    // non-null forever, and integration resolves
    // `importance ?? importance_signal ?? domain default ?? baseline` — a
    // non-null first link short-circuits the rest, so the provider's LLM
    // judgement and the domain's default were both unreachable and every fact
    // scored 0.5.
    //
    // Capture cannot know a fact's importance: the domain has not been
    // classified yet. null means "not scored", which is true. The baseline is
    // still applied — at integration, where the domain is known. See
    // tests/intelligence/importance.test.ts.
    const { factManager } = await setup();

    const fact = await factManager.captureFact({ content: "Some random fact" });
    expect(fact!.importance).toBeNull();
  });

  it("uses configured default confidence", async () => {
    const sessionManager = sessionMod.createSessionManager(db);
    await sessionManager.startSession("test", null);
    const factManager = factMod.createFactManager(db, sessionManager, {
      captureConfig: { default_confidence: 0.8 },
    });

    const fact = await factManager.captureFact({ content: "High confidence" });
    expect(fact!.confidence).toBe(0.8);
  });

  it("auto-links to recent events as contextual sources", async () => {
    const { sessionManager, factManager } = await setup();

    // Log some events first
    await sessionManager.logEvent({
      event_type: "message",
      role: "user",
      content: "Hello",
    });
    await sessionManager.logEvent({
      event_type: "message",
      role: "assistant",
      content: "Hi there",
    });

    const fact = await factManager.captureFact({ content: "User greeted" });
    const sources = await dbMod.getFactSources(db, fact!.id);

    expect(sources.length).toBe(2);
    expect(sources.every((s: any) => s.extraction_type === "contextual")).toBe(true);
  });

  it("links explicit source_event_id as primary source", async () => {
    const { sessionManager, factManager } = await setup();

    const event = await sessionManager.logEvent({
      event_type: "message",
      role: "user",
      content: "My name is Alex",
    });

    const fact = await factManager.captureFact({
      content: "User's name is Alex",
      source_event_id: event.id,
    });

    const sources = await dbMod.getFactSources(db, fact!.id);
    const primary = sources.find((s: any) => s.extraction_type === "primary");
    expect(primary).toBeDefined();
    expect(primary!.event_id).toBe(event.id);
    expect(primary!.relevance).toBe(1.0);
  });

  it("capture_fact completes in under 50ms", async () => {
    const { factManager } = await setup();

    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      await factManager.captureFact({ content: `fact number ${i}` });
    }
    const elapsed = performance.now() - start;
    const perFact = elapsed / 10;

    expect(perFact).toBeLessThan(50);
  });
});

describe("get_session_context", () => {
  it("returns facts from the current session", async () => {
    const sessionManager = sessionMod.createSessionManager(db);
    await sessionManager.startSession("test", null);
    const factManager = factMod.createFactManager(db, sessionManager);

    await factManager.captureFact({ content: "fact A" });
    await factManager.captureFact({ content: "fact B" });

    const context = await factManager.getSessionContext();
    expect(context).toHaveLength(2);
    expect(context[0].content).toBe("fact A");
    expect(context[1].content).toBe("fact B");
  });

  it("returns empty array when no active session", async () => {
    const sessionManager = sessionMod.createSessionManager(db);
    const factManager = factMod.createFactManager(db, sessionManager);

    const context = await factManager.getSessionContext();
    expect(context).toHaveLength(0);
  });

  it("returns facts for a specific session ID", async () => {
    const sessionManager = sessionMod.createSessionManager(db);
    const s1 = await sessionManager.startSession("test", null);
    const factManager = factMod.createFactManager(db, sessionManager);

    await factManager.captureFact({ content: "session 1 fact" });

    // Start a new session
    const s2 = await sessionManager.startSession("test", null);
    await factManager.captureFact({ content: "session 2 fact" });

    // Query the first session by ID
    const context = await factManager.getSessionContext(s1.id);
    expect(context).toHaveLength(1);
    expect(context[0].content).toBe("session 1 fact");
  });

  it("returns zero facts after consolidation (D1)", async () => {
    const heuristicMod = await import("../../src/intelligence/heuristic.js");
    const sessionManager = sessionMod.createSessionManager(db);
    await sessionManager.startSession("test", null);
    const factManager = factMod.createFactManager(db, sessionManager, {
      intelligence: heuristicMod.createHeuristicProvider(PERSONAL_VOCABULARY),
    });

    await factManager.captureFact({ content: "fact A", domain_hint: "profile" });
    await factManager.captureFact({ content: "fact B", domain_hint: "profile" });

    // Before consolidation: both facts visible
    expect(await factManager.getSessionContext()).toHaveLength(2);

    // After consolidation: no unconsolidated facts remain
    await factManager.runConsolidate();
    expect(await factManager.getSessionContext()).toHaveLength(0);
  });
});
