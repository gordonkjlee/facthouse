/**
 * The two capture paths must produce comparable knowledge.
 *
 * A fact can enter the store two ways: an assistant calls `capture_fact`, or
 * the server infers it from raw conversation events during consolidation. The
 * first is the primary path, named in every tool description. The second is
 * documented as an optional safety net.
 *
 * They silently stopped being comparable. Inferred facts were classified and
 * had their entities extracted by the model during the extraction stage, while
 * explicit captures reached provider methods that delegated straight to the
 * heuristic — which, once the engine stopped shipping a vocabulary and a name
 * regex, routed everything to the default domain and extracted nothing. The
 * safety net was producing strictly better knowledge than the thing it backs up.
 *
 * Nothing caught it, because every test exercised one path or the other and
 * none compared them. That is the gap this file exists to close, and the reason
 * it asserts a *relationship between two runs* rather than the output of one.
 *
 * The subprocess is mocked, so this is deterministic and runs in CI. It cannot
 * speak to the quality of what a real model returns — only that both paths ask
 * it and use the answer. That is exactly the failure that shipped: not a bad
 * answer, but one path never asking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Db } from "../../src/db/connection.js";

// ---------------------------------------------------------------------------
// Mock the subprocess before importing anything that reaches for it
// ---------------------------------------------------------------------------

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void; write: () => void };
  kill: (sig?: string) => void;
}

/** Stages are identified by the opening words of their system prompt. */
function structuredOutputFor(prompt: string): Record<string, unknown> | null {
  if (prompt.startsWith("You extract durable facts from conversation events")) {
    return {
      facts: [
        {
          content: CONTENT,
          domain: "work",
          subdomain: "leadership",
          confidence: 0.9,
          importance: 0.8,
          entities: ENTITIES,
        },
      ],
    };
  }
  if (prompt.startsWith("You route already-extracted facts into domains")) {
    // Echo the ids the caller sent, so this answers whatever it is given.
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    return {
      classifications: ids.map((id) => ({
        id,
        domain: "work",
        subdomain: "leadership",
      })),
    };
  }
  if (prompt.startsWith("You identify the named things each fact concerns")) {
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    return { facts: ids.map((id) => ({ id, entities: ENTITIES })) };
  }
  if (prompt.startsWith("You decide whether a candidate fact")) {
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    return { decisions: ids.map((id) => ({ id, decision: "add" })) };
  }
  // Supersession, summary and anything else: let the provider fall back. Those
  // stages are not what this file is about.
  return null;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      const child = new EventEmitter() as MockChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {}, write: () => {} };
      child.kill = () => {};
      const prompt = args[args.length - 1];
      queueMicrotask(() => {
        const structured = structuredOutputFor(prompt);
        if (structured === null) {
          child.emit("close", 1); // provider falls back for this stage
          return;
        }
        child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ is_error: false, result: "", structured_output: structured })),
        );
        child.emit("close", 0);
      });
      return child;
    },
  };
});

const CONTENT = "Robin at Acme leads the Atlas migration this quarter.";
const ENTITIES = [
  { name: "Robin", type: "person", relationship: "subject_of" },
  { name: "Acme", type: "organisation", relationship: "employer" },
  { name: "Atlas", type: "project", relationship: "migration_led" },
];

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession, insertEvent } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createCliProvider } = await import("../../src/intelligence/cli.js");

interface Captured {
  domain: string;
  subdomain: string | null;
  entities: string[];
  subjects: string[];
}

/** Everything a caller would see about the single fact a run produced. */
function readBack(db: Db): Captured {
  const fact = db
    .prepare(`SELECT id, domain, subdomain FROM facts`)
    .get() as { id: string; domain: string; subdomain: string | null };

  const links = db
    .prepare(
      `SELECT e.name AS name, fe.relationship AS relationship
         FROM fact_entities fe JOIN entities e ON e.id = fe.entity_id
        WHERE fe.fact_id = ?`,
    )
    .all(fact.id) as Array<{ name: string; relationship: string }>;

  return {
    domain: fact.domain,
    subdomain: fact.subdomain,
    entities: links.map((l) => l.name).sort(),
    subjects: links.filter((l) => l.relationship === "subject_of").map((l) => l.name).sort(),
  };
}

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => {
  closeDatabase(db);
  vi.restoreAllMocks();
});

/** The primary path: an assistant calls capture_fact, which stages the fact. */
async function viaExplicitCapture(): Promise<Captured> {
  const session = createSession(db, { source_tool: "test", project: null });
  insertSessionFact(db, {
    session_id: session.id,
    content: CONTENT,
    source_origin: "explicit",
  });
  await consolidate(db, createCliProvider(), { extraction: { enabled: false } as any });
  return readBack(db);
}

/** The safety net: the same sentence arrives as a raw conversation event. */
async function viaEventExtraction(): Promise<Captured> {
  const session = createSession(db, { source_tool: "test", project: null });
  insertEvent(db, {
    mcp_session_id: session.id,
    event_type: "message",
    role: "user",
    content: CONTENT,
  });
  await consolidate(db, createCliProvider(), { extraction: { enabled: true } as any });
  return readBack(db);
}

describe("capture paths produce comparable knowledge", () => {
  it("routes to a real domain whichever way the fact arrived", async () => {
    const explicit = await viaExplicitCapture();
    expect(explicit.domain).toBe("work");
    // The regression that shipped: the default domain, silently, because the
    // only implementation this path reached had no vocabulary to route with.
    expect(explicit.domain).not.toBe("general");
    expect(explicit.subdomain).toBe("leadership");
  });

  it("builds the same entity graph whichever way the fact arrived", async () => {
    const explicit = await viaExplicitCapture();
    expect(explicit.entities).toEqual(["Acme", "Atlas", "Robin"]);
    expect(explicit.subjects).toEqual(["Robin"]);
  });

  it("gives the two paths the same answer", async () => {
    // The assertion the codebase was missing. Either path may change; they may
    // not diverge without someone deciding they should.
    const explicit = await viaExplicitCapture();
    closeDatabase(db);
    db = openDatabase(":memory:");
    applySchema(db);
    const inferred = await viaEventExtraction();

    expect(explicit).toEqual(inferred);
  });
});
