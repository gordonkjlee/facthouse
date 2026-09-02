/**
 * Speaker role on I and K — the primary event's channel, not capture path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { openDatabase, closeDatabase } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { createSession, insertEvent } from "../../src/db/sessions.js";
import { insertSessionFact } from "../../src/db/session-facts.js";
import {
  primaryEventForFact,
  speakerRoleOf,
  UTTERED_BY,
} from "../../src/db/session-facts.js";
import { createEntity, findEntity, recordSameAs } from "../../src/db/entities.js";
import { consolidate } from "../../src/intelligence/consolidate.js";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { SessionEvent } from "../../src/types/data.js";
import { formatSearch } from "../../src/cli/query.js";
import type { SearchResponse } from "../../src/types/data.js";

const GRAIN = "Bookings are the grain of the orders mart at Acme.";

function recording(facts: Array<{ content: string }>) {
  const heuristic = createHeuristicProvider();
  return {
    ...heuristic,
    async extractFactsFromEvents(events: SessionEvent[]) {
      const hit = events.some((e) => (e.content ?? "").includes(GRAIN));
      return {
        facts: hit ? facts.map((f) => ({ content: f.content, domain_hint: "pipeline" })) : [],
        degraded: false,
      };
    },
  };
}

describe("speakerRoleOf / primaryEventForFact", () => {
  it("accepts the four event roles and declines anything else", () => {
    expect(speakerRoleOf("user")).toBe("user");
    expect(speakerRoleOf("assistant")).toBe("assistant");
    expect(speakerRoleOf("system")).toBe("system");
    expect(speakerRoleOf("tool")).toBe("tool");
    expect(speakerRoleOf("human")).toBeNull();
    expect(speakerRoleOf(null)).toBeNull();
  });

  it("picks the first event whose text still contains the fact", () => {
    const events = [
      { id: "a", content: "noise", role: "user" },
      { id: "b", content: `Yes. ${GRAIN}`, role: "assistant" },
      { id: "c", content: GRAIN, role: "user" },
    ] as SessionEvent[];
    expect(primaryEventForFact(events, GRAIN)?.id).toBe("b");
    expect(primaryEventForFact(events, "unsaid")?.id).toBeUndefined();
  });
});

describe("extract stamps speaker_role from the primary event", () => {
  let db: Db;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await applySchema(db);
  });

  afterEach(async () => {
    await closeDatabase(db);
  });

  async function run(role: "user" | "assistant") {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role,
      content: GRAIN,
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    return (await db
      .prepare(`SELECT speaker_role FROM facts WHERE content = ?`)
      .get(GRAIN)) as { speaker_role: string | null };
  }

  it("is user when the user stated the sentence", async () => {
    expect((await run("user")).speaker_role).toBe("user");
  });

  it("is assistant when the assistant stated the sentence", async () => {
    expect((await run("assistant")).speaker_role).toBe("assistant");
  });

  it("is null when I has no primary event", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertSessionFact(db, {
      session_id: session.id,
      content: GRAIN,
      source_origin: "inferred",
    });
    await consolidate(db, createHeuristicProvider(), {
      extraction: { enabled: false } as never,
    });
    const integrated = (await db
      .prepare(`SELECT speaker_role, speaker FROM facts WHERE content = ?`)
      .get(GRAIN)) as { speaker_role: string | null; speaker: string | null };
    expect(integrated.speaker_role).toBeNull();
    expect(integrated.speaker).toBeNull();
  });

  it("copies a named speaker from the primary event onto I and K", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const staged = (await db
      .prepare(`SELECT speaker, speaker_role FROM session_facts WHERE content = ?`)
      .get(GRAIN)) as { speaker: string | null; speaker_role: string | null };
    expect(staged.speaker).toBe("Alex");
    expect(staged.speaker_role).toBe("user");
    const integrated = (await db
      .prepare(`SELECT speaker, speaker_role FROM facts WHERE content = ?`)
      .get(GRAIN)) as { speaker: string | null; speaker_role: string | null };
    expect(integrated.speaker).toBe("Alex");
    expect(integrated.speaker_role).toBe("user");
  });

  it("does not mint an entity from a display name", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    expect(await findEntity(db, "Alex")).toBeNull();
  });

  it("links uttered_by when the named speaker already exists", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    const person = await createEntity(db, { type: "person", name: "Alex" });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const link = (await db
      .prepare(
        `SELECT fe.relationship
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.entity_id = ? AND f.content = ?`,
      )
      .get(person.id, GRAIN)) as { relationship: string };
    expect(link.relationship).toBe(UTTERED_BY);
  });

  it("links uttered_by the person when Alex is also a project", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    const project = await createEntity(db, { type: "project", name: "Alex" });
    const person = await createEntity(db, { type: "person", name: "Alex" });
    await db.prepare(`UPDATE entities SET created_at = ? WHERE id = ?`).run(
      "2026-01-01T00:00:00.000Z",
      project.id,
    );
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const onPerson = (await db
      .prepare(
        `SELECT fe.relationship
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.entity_id = ? AND f.content = ?`,
      )
      .get(person.id, GRAIN)) as { relationship: string } | undefined;
    const onProject = (await db
      .prepare(
        `SELECT fe.relationship
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.entity_id = ? AND f.content = ?`,
      )
      .get(project.id, GRAIN)) as { relationship: string } | undefined;
    expect(onPerson?.relationship).toBe(UTTERED_BY);
    expect(onProject).toBeUndefined();
  });

  it("links uttered_by after same_as of two person names", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    const alexander = await createEntity(db, { type: "person", name: "Alexander" });
    const alex = await createEntity(db, { type: "person", name: "Alex" });
    await recordSameAs(db, alexander.id, alex.id);
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const onAlex = (await db
      .prepare(
        `SELECT fe.relationship
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.entity_id = ? AND f.content = ?`,
      )
      .get(alex.id, GRAIN)) as { relationship: string } | undefined;
    expect(onAlex).toBeDefined();
    expect(onAlex!.relationship).toBe(UTTERED_BY);
  });

  it("does not tag a project as speaker when no person exists", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    const project = await createEntity(db, { type: "project", name: "Alex" });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const onProject = (await db
      .prepare(
        `SELECT fe.relationship
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.entity_id = ? AND f.content = ?`,
      )
      .get(project.id, GRAIN)) as { relationship: string } | undefined;
    expect(onProject).toBeUndefined();
  });
});

describe("CLI search names the speaker when known", () => {
  it("renders speaker assistant on a result", () => {
    const out = formatSearch(
      {
        results: [
          {
            fact: {
              content: GRAIN,
              domain: "pipeline",
              subdomain: null,
              confidence: 0.9,
              speaker_role: "assistant",
            },
            score: 0.5,
            entities: [],
            source: null,
          },
        ],
        pending: [],
        episodes: [],
        coverage_estimate: 1,
        result_confidence: 1,
        suggested_refinement: null,
      } as unknown as SearchResponse,
      "bookings",
    );
    expect(out).toContain("speaker assistant");
  });

  it("prefers a named speaker over the role", () => {
    const out = formatSearch(
      {
        results: [
          {
            fact: {
              content: GRAIN,
              domain: "pipeline",
              subdomain: null,
              confidence: 0.9,
              speaker_role: "user",
              speaker: "Alex",
            },
            score: 0.5,
            entities: [],
            source: null,
          },
        ],
        pending: [],
        episodes: [],
        coverage_estimate: 1,
        result_confidence: 1,
        suggested_refinement: null,
      } as unknown as SearchResponse,
      "bookings",
    );
    expect(out).toContain("speaker Alex");
    expect(out).not.toContain("speaker user");
  });
});
