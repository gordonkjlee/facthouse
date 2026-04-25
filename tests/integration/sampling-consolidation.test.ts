/**
 * End-to-end test: session_events → sampling provider → consolidate() →
 * graduated facts + entities.
 *
 * Stubs server.createMessage with canned JSON responses that mimic what a
 * real host LLM would return, and drives consolidate() through the sampling
 * provider. Exercises the full Phase B (event extraction) + Phase C
 * (classify / extract entities / reconcile / supersede / graduate) pipeline.
 *
 * Purpose: catches wiring bugs between the sampling provider's JSON contract
 * and the downstream consolidation code that the unit-level sampling tests
 * can't see.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type Database from "better-sqlite3";

let canLoadSqlite = false;
try {
  const Db = (await import("better-sqlite3")).default;
  const probe = new Db(":memory:");
  probe.close();
  canLoadSqlite = true;
} catch {}

const { openDatabase, closeDatabase } = canLoadSqlite
  ? await import("../../src/db/connection.js")
  : ({} as any);
const { applySchema } = canLoadSqlite
  ? await import("../../src/db/schema.js")
  : ({} as any);
const { createSession, insertEvent } = canLoadSqlite
  ? await import("../../src/db/sessions.js")
  : ({} as any);
const { consolidate } = canLoadSqlite
  ? await import("../../src/intelligence/consolidate.js")
  : ({} as any);
const { createSamplingProvider } = canLoadSqlite
  ? await import("../../src/intelligence/sampling.js")
  : ({} as any);

let db: Database.Database;
let sessionId: string;

beforeEach(() => {
  if (!canLoadSqlite) return;
  db = openDatabase(":memory:");
  applySchema(db);
  sessionId = createSession(db, { source_tool: "test", project: "om" }).id;
});

afterEach(() => {
  if (!canLoadSqlite) return;
  closeDatabase(db);
});

/**
 * Build a Server stub whose createMessage responds based on the system
 * prompt content. This lets each intelligence call return an appropriate
 * canned payload without us having to reason about call order.
 */
function makeSamplingStub(): { server: Server; calls: number } {
  const state = { calls: 0 };
  const createMessage = vi.fn(async (params: any) => {
    state.calls++;
    const sys: string = params.systemPrompt ?? "";
    // Match on stable snippets of each prompt in src/intelligence/sampling.ts.
    if (sys.includes("extract durable facts")) {
      return {
        content: {
          type: "text",
          text: JSON.stringify([
            { content: "The user is allergic to aspirin", domain_hint: "medical" },
            { content: "The user's partner is Robin", domain_hint: "people" },
          ]),
        },
      };
    }
    if (sys.includes("classify user facts")) {
      // facts: SessionFact[]. Echo back with explicit domains. The payload
      // in the user text contains the facts with their ids.
      const userText: string = params.messages[0].content.text;
      const match = userText.match(/\[.*\]/s);
      const arr: Array<{ id: string; content: string; domain_hint: string | null }> =
        match ? JSON.parse(match[0]) : [];
      const classified = arr.map((f) => ({
        id: f.id,
        domain: f.domain_hint ?? "general",
        subdomain: null as string | null,
      }));
      return {
        content: { type: "text", text: JSON.stringify(classified) },
      };
    }
    if (sys.includes("extract entities")) {
      const userText: string = params.messages[0].content.text;
      const match = userText.match(/\[.*\]/s);
      const arr: Array<{ id: string; content: string }> = match ? JSON.parse(match[0]) : [];
      const map: Record<string, Array<{ name: string; type: string; relationship: string }>> = {};
      for (const f of arr) {
        if (f.content.includes("Robin")) {
          map[f.id] = [{ name: "Robin", type: "person", relationship: "partner_of" }];
        }
      }
      return { content: { type: "text", text: JSON.stringify(map) } };
    }
    if (sys.includes("detect whether a new fact supersedes")) {
      return { content: { type: "text", text: "null" } };
    }
    if (sys.includes("decide whether a candidate fact is already covered")) {
      return {
        content: { type: "text", text: JSON.stringify({ decision: "add" }) },
      };
    }
    if (sys.includes("summarise a consolidation run")) {
      return {
        content: {
          type: "text",
          text: JSON.stringify({ summary: "Captured medical and partner facts.", openThreads: [] }),
        },
      };
    }
    throw new Error(`Unhandled sampling prompt: ${sys.slice(0, 50)}`);
  });

  const server = {
    getClientCapabilities: () => ({ sampling: {} }),
    createMessage,
  } as unknown as Server;

  return { server, calls: state.calls };
}

describe.skipIf(!canLoadSqlite)("end-to-end sampling consolidation", () => {
  it("extracts, classifies, resolves entities, and graduates facts", async () => {
    // Seed raw conversation events.
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "Yeah I can't eat aspirin — discovered that the hard way.",
    });
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "My partner Robin is coming to dinner tonight.",
    });

    const { server } = makeSamplingStub();
    const provider = createSamplingProvider(server);

    const result = await consolidate(db, provider, {
      extraction: { enabled: true } as any,
    });

    expect(result.skipped).toBe(false);
    expect(result.factsIn).toBe(2);
    expect(result.factsGraduated).toBe(2);
    expect(result.entitiesCreated).toBeGreaterThanOrEqual(1);

    const facts = db.prepare(`SELECT content, domain FROM facts`).all() as Array<{
      content: string;
      domain: string;
    }>;
    expect(facts).toHaveLength(2);
    expect(facts.some((f) => f.domain === "medical")).toBe(true);
    expect(facts.some((f) => f.domain === "people")).toBe(true);

    const entities = db
      .prepare(`SELECT name, type FROM entities`)
      .all() as Array<{ name: string; type: string }>;
    expect(entities.some((e) => e.name === "Robin" && e.type === "person")).toBe(true);

    const links = db.prepare(`SELECT COUNT(*) AS n FROM fact_entities`).get() as {
      n: number;
    };
    expect(links.n).toBeGreaterThanOrEqual(1);

    const consolidations = db
      .prepare(`SELECT facts_graduated, last_event_sequence FROM consolidations`)
      .all() as Array<{ facts_graduated: number; last_event_sequence: number }>;
    expect(consolidations).toHaveLength(1);
    expect(consolidations[0].facts_graduated).toBe(2);
    expect(consolidations[0].last_event_sequence).toBe(2);
  });

  it("produces no facts when the LLM returns an empty extraction", async () => {
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "hello world",
    });

    const createMessage = vi.fn(async (params: any) => {
      const sys: string = params.systemPrompt ?? "";
      if (sys.includes("extract durable facts")) {
        return { content: { type: "text", text: "[]" } };
      }
      // No other calls should happen when extraction is empty.
      throw new Error("Unexpected sampling call after empty extraction");
    });
    const server = {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage,
    } as unknown as Server;

    const provider = createSamplingProvider(server);
    const result = await consolidate(db, provider, {
      extraction: { enabled: true } as any,
    });

    expect(result.factsGraduated).toBe(0);
    const facts = db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number };
    expect(facts.n).toBe(0);
    // But a watermark row still lands — event was consumed.
    const consRow = db
      .prepare(`SELECT last_event_sequence FROM consolidations`)
      .get() as { last_event_sequence: number };
    expect(consRow.last_event_sequence).toBe(1);
  });

  it("falls back to heuristic when createMessage throws for one method", async () => {
    insertEvent(db, {
      mcp_session_id: sessionId,
      event_type: "message",
      role: "user",
      content: "I'm allergic to aspirin.",
    });

    // Extraction works; classifyFacts throws. Heuristic classifier should
    // kick in and route the fact to 'medical' via keyword.
    const createMessage = vi.fn(async (params: any) => {
      const sys: string = params.systemPrompt ?? "";
      if (sys.includes("extract durable facts")) {
        return {
          content: {
            type: "text",
            text: JSON.stringify([
              { content: "The user is allergic to aspirin", domain_hint: "medical" },
            ]),
          },
        };
      }
      if (sys.includes("classify user facts")) {
        throw new Error("sampling classifier unavailable");
      }
      // Other calls return safe stubs.
      if (sys.includes("extract entities")) {
        return { content: { type: "text", text: "{}" } };
      }
      if (sys.includes("detect whether a new fact supersedes")) {
        return { content: { type: "text", text: "null" } };
      }
      if (sys.includes("decide whether a candidate fact is already covered")) {
        return {
          content: { type: "text", text: JSON.stringify({ decision: "add" }) },
        };
      }
      if (sys.includes("summarise")) {
        return {
          content: {
            type: "text",
            text: JSON.stringify({ summary: "ok", openThreads: [] }),
          },
        };
      }
      throw new Error(`unhandled prompt: ${sys.slice(0, 40)}`);
    });
    const server = {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage,
    } as unknown as Server;

    const provider = createSamplingProvider(server);
    const result = await consolidate(db, provider, {
      extraction: { enabled: true } as any,
    });

    expect(result.factsGraduated).toBe(1);
    const facts = db.prepare(`SELECT domain FROM facts`).all() as Array<{ domain: string }>;
    expect(facts[0].domain).toBe("medical");
  });
});
