/**
 * End-to-end: CLI provider drives consolidate(), writes to all K-layer tables.
 *
 * Mocks child_process.spawn so we don't make real claude CLI calls. Each
 * stage's response is canned to simulate what a real LLM would return —
 * exercises extraction → entity resolution → reconcile → graduate → summarise.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Db } from "../../src/db/connection.js";

// ---------------------------------------------------------------------------
// Mock spawn — must happen before importing consolidate/cli provider.
// ---------------------------------------------------------------------------

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void; write: () => void };
  kill: (sig?: string) => void;
}

let behaviour: (args: string[]) => Record<string, unknown> | null = () => null;

vi.mock("node:child_process", () => ({
  spawn: (_cmd: string, args: string[]) => {
    const child = new EventEmitter() as MockChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {}, write: () => {} };
    child.kill = () => {};
    queueMicrotask(() => {
      const envelope = behaviour(args);
      if (envelope === null) {
        child.emit("close", 1);
        return;
      }
      child.stdout.emit("data", Buffer.from(JSON.stringify(envelope)));
      child.emit("close", 0);
    });
    return child;
  },
}));

// ---------------------------------------------------------------------------
// Guard: skip when native bindings are unavailable
// ---------------------------------------------------------------------------


const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession, insertEvent } = await import("../../src/db/sessions.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createCliProvider } = await import("../../src/intelligence/cli.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routeByPromptPrefix(args: string[]): string {
  // The prompt is the last positional argv entry.
  const prompt = args[args.length - 1];
  if (prompt.includes("extract durable facts")) return "stage-1";
  if (prompt.includes("decide whether a candidate")) return "stage-2";
  if (prompt.includes("detect whether a new fact supersedes")) return "stage-3";
  if (prompt.includes("summarise a consolidation run")) return "stage-4";
  return "unknown";
}

let db: Db;
let sessionId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
  sessionId = createSession(db, { source_tool: "test", project: "om" }).id;
});

afterEach(() => {
  closeDatabase(db);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI provider end-to-end consolidation", () => {
  it("extracts facts with entities, graduates them, writes all K-layer rows", async () => {
    // Seed events.
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "I'm allergic to aspirin. My partner Robin loves sushi.",
    });

    behaviour = (args) => {
      const stage = routeByPromptPrefix(args);
      if (stage === "stage-1") {
        return {
          is_error: false,
          result: "",
          structured_output: {
            facts: [
              {
                content: "Allergic to aspirin",
                domain: "medical",
                subdomain: "allergy",
                confidence: 0.95,
                importance: 0.9,
                capture_context: "discussing allergies",
                valid_from: null,
                valid_until: null,
                entities: [
                  { name: "aspirin", type: "substance", relationship: "allergic_to" },
                ],
              },
              {
                content: "Partner Robin loves sushi",
                domain: "preferences",
                subdomain: "food",
                confidence: 0.85,
                importance: 0.4,
                capture_context: null,
                valid_from: null,
                valid_until: null,
                entities: [
                  { name: "Robin", type: "person", relationship: "partner_of" },
                  { name: "sushi", type: "food", relationship: "likes" },
                ],
              },
            ],
          },
        };
      }
      if (stage === "stage-2") {
        // reconcile — empty existing domain → always 'add'; but provider
        // shortcircuits without calling subprocess in that case. This path
        // only hits when there ARE existing facts. Return add for safety.
        return {
          is_error: false,
          structured_output: { decisions: [{ id: "_", decision: "add" }] },
        };
      }
      if (stage === "stage-3") {
        return {
          is_error: false,
          structured_output: { supersessions: [] },
        };
      }
      if (stage === "stage-4") {
        return {
          is_error: false,
          structured_output: {
            summary: "User disclosed a aspirin allergy and their partner Robin's love of sushi.",
            openThreads: [],
          },
        };
      }
      return null;
    };

    const provider = createCliProvider();
    const result = await consolidate(db, provider, {
      extraction: { enabled: true } as any,
    });

    expect(result.skipped).toBe(false);
    expect(result.factsGraduated).toBe(2);

    // facts: content paraphrased from raw events, domain + subdomain set
    const facts = db
      .prepare(`SELECT content, domain, subdomain, source_quality, confidence FROM facts`)
      .all() as Array<{
      content: string;
      domain: string;
      subdomain: string | null;
      source_quality: string;
      confidence: number;
    }>;
    expect(facts).toHaveLength(2);
    expect(facts.some((f) => f.domain === "medical" && f.subdomain === "allergy")).toBe(true);
    expect(facts.some((f) => f.domain === "preferences" && f.subdomain === "food")).toBe(true);
    expect(facts.every((f) => f.source_quality === "cli")).toBe(true);
    expect(facts.find((f) => f.domain === "medical")?.confidence).toBeGreaterThan(0.9);

    // entities: mixed types populated from stage 1 output
    const entities = db
      .prepare(`SELECT name, type FROM entities`)
      .all() as Array<{ name: string; type: string }>;
    const entityKinds = new Set(entities.map((e) => e.type));
    expect(entityKinds.has("person")).toBe(true);
    expect(entityKinds.has("substance")).toBe(true);
    expect(entityKinds.has("food")).toBe(true);

    // fact_entities: typed relationships
    const links = db
      .prepare(`SELECT relationship FROM fact_entities`)
      .all() as Array<{ relationship: string }>;
    const rels = new Set(links.map((l) => l.relationship));
    expect(rels.has("allergic_to")).toBe(true);
    expect(rels.has("partner_of")).toBe(true);
    expect(rels.has("likes")).toBe(true);

    // entity_edges: co-mentioned Robin + sushi
    const edges = db
      .prepare(`SELECT COUNT(*) n FROM entity_edges WHERE relationship = 'co_mentioned'`)
      .get() as { n: number };
    expect(edges.n).toBeGreaterThanOrEqual(1);

    // consolidations: summary is the LLM paragraph, not a template
    const cons = db
      .prepare(`SELECT summary, last_event_sequence FROM consolidations`)
      .get() as { summary: string; last_event_sequence: number };
    expect(cons.summary).toContain("Robin");
    expect(cons.last_event_sequence).toBeGreaterThan(0);
  });

  it("reuses existing entities via existing_id resolution", async () => {
    // Pre-seed an entity: Alex.
    const existing = db
      .prepare(
        `INSERT INTO entities (id, type, name, canonical_name, created_at, access_count)
         VALUES ('ent-alex', 'person', 'Alex', 'alex', datetime('now'), 0)`,
      )
      .run();
    expect(existing.changes).toBe(1);

    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "Lex mentioned that he prefers tea.",
    });

    behaviour = (args) => {
      const stage = routeByPromptPrefix(args);
      if (stage === "stage-1") {
        return {
          is_error: false,
          structured_output: {
            facts: [
              {
                content: "Lex prefers tea",
                domain: "preferences",
                subdomain: null,
                confidence: 0.8,
                importance: 0.3,
                capture_context: null,
                valid_from: null,
                valid_until: null,
                entities: [
                  {
                    name: "Lex",
                    type: "person",
                    relationship: "mentioned",
                    existing_id: "ent-alex", // LLM resolved to existing
                  },
                  { name: "tea", type: "beverage", relationship: "likes" },
                ],
              },
            ],
          },
        };
      }
      if (stage === "stage-3" || stage === "stage-2") {
        return {
          is_error: false,
          structured_output:
            stage === "stage-2"
              ? { decisions: [{ id: "_", decision: "add" }] }
              : { supersessions: [] },
        };
      }
      if (stage === "stage-4") {
        return {
          is_error: false,
          structured_output: { summary: "Lex prefers tea.", openThreads: [] },
        };
      }
      return null;
    };

    const provider = createCliProvider();
    await consolidate(db, provider, { extraction: { enabled: true } as any });

    // Only ONE entity should have name 'Alex' or 'Lex' — the LLM-resolved
    // id means the extracted mention reuses the existing entity.
    const personEntities = db
      .prepare(`SELECT id, name FROM entities WHERE type = 'person'`)
      .all() as Array<{ id: string; name: string }>;
    expect(personEntities).toHaveLength(1);
    expect(personEntities[0].id).toBe("ent-alex");
    expect(personEntities[0].name).toBe("Alex"); // not overwritten

    // The fact should be linked to the existing entity.
    const link = db
      .prepare(
        `SELECT entity_id FROM fact_entities WHERE entity_id = 'ent-alex'`,
      )
      .all();
    expect(link.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to heuristic on total spawn failure", async () => {
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "I'm allergic to aspirin",
    });

    behaviour = () => null; // spawn returns exit code 1

    const provider = createCliProvider();
    const result = await consolidate(db, provider, {
      extraction: { enabled: true } as any,
    });

    // A total spawn failure degrades; it does not throw and does not corrupt.
    //
    // This used to assert the fallback extracted "allergic to aspirin" from the
    // raw event. It no longer can: those first-person regexes were a personal
    // ontology hardcoded in a general engine, and they are gone. Extracting
    // facts from conversation requires an LLM, so with the LLM unavailable there
    // is nothing to extract — which is the honest outcome, not a silent
    // pretence of intelligence.
    expect(result.skipped).toBe(false);
    expect(result.factsGraduated).toBe(0);

    // Explicit captures are unaffected by the LLM being down — only inference is.
    const facts = db.prepare(`SELECT COUNT(*) c FROM facts`).get() as { c: number };
    expect(facts.c).toBe(0);
  });
});
