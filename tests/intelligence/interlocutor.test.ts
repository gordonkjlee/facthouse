/**
 * Owner speech, backing records, and refuse-to-invent people.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { openDatabase, closeDatabase } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { createSession, insertEvent } from "../../src/db/sessions.js";
import { UTTERED_BY, getFactSources } from "../../src/db/session-facts.js";
import { findEntity, getSelfEntity } from "../../src/db/entities.js";
import { consolidate } from "../../src/intelligence/consolidate.js";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { SessionEvent } from "../../src/types/data.js";
import { hybridSearch } from "../../src/search/index.js";
import { insertFact } from "../../src/db/facts.js";

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

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

async function sourcesOf(content: string) {
  const row = (await db
    .prepare(`SELECT id FROM session_facts WHERE content = ?`)
    .get(content)) as { id: string } | undefined;
  expect(row).toBeTruthy();
  return getFactSources(db, row!.id);
}

describe("owner speech (E)", () => {
  it("links unnamed user-channel speech as uttered_by the self entity", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const self = await getSelfEntity(db);
    expect(self).toBeTruthy();
    const link = (await db
      .prepare(
        `SELECT fe.relationship
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.entity_id = ? AND f.content = ?`,
      )
      .get(self!.id, GRAIN)) as { relationship: string };
    expect(link.relationship).toBe(UTTERED_BY);
    const integrated = (await db
      .prepare(`SELECT speaker, speaker_role FROM facts WHERE content = ?`)
      .get(GRAIN)) as { speaker: string | null; speaker_role: string | null };
    expect(integrated.speaker).toBeNull();
    expect(integrated.speaker_role).toBe("user");
    expect(integrated.speaker).not.toBe("self");
    expect(integrated.speaker).not.toBe("the user");
  });

  it("does not treat a named user speaker as the owner", async () => {
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
    const self = await getSelfEntity(db);
    const uttered = (await db
      .prepare(
        `SELECT fe.entity_id
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.relationship = ? AND f.content = ?`,
      )
      .all(UTTERED_BY, GRAIN)) as Array<{ entity_id: string }>;
    expect(uttered.every((r) => r.entity_id !== self!.id)).toBe(true);
  });

  it("does not attribute unnamed assistant speech to the owner", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "assistant",
      content: GRAIN,
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const uttered = (await db
      .prepare(
        `SELECT fe.entity_id
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.relationship = ? AND f.content = ?`,
      )
      .all(UTTERED_BY, GRAIN)) as Array<{ entity_id: string }>;
    expect(uttered).toHaveLength(0);
  });
});

describe("backing records (C)", () => {
  it("records assent after a proposal without changing confidence", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "assistant",
      content: GRAIN,
    });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: "yes",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const kinds = (await sourcesOf(GRAIN)).map((s) => s.extraction_type);
    expect(kinds).toContain("primary");
    expect(kinds).toContain("assent");
    expect(kinds.filter((k) => k === "assent")).toHaveLength(1);
    const fact = (await db
      .prepare(`SELECT confidence FROM facts WHERE content = ?`)
      .get(GRAIN)) as { confidence: number };
    const twin = openDatabase(":memory:");
    await applySchema(twin);
    const session2 = await createSession(twin, { source_tool: "test", project: null });
    await insertEvent(twin, {
      mcp_session_id: session2.id,
      event_type: "message",
      role: "assistant",
      content: GRAIN,
    });
    await consolidate(twin, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const without = (await twin
      .prepare(`SELECT confidence FROM facts WHERE content = ?`)
      .get(GRAIN)) as { confidence: number };
    expect(fact.confidence).toBe(without.confidence);
    await closeDatabase(twin);
  });

  it("records one assent when the user says yes twice", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "assistant",
      content: GRAIN,
    });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: "yes",
    });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: "yeah",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const kinds = (await sourcesOf(GRAIN)).map((s) => s.extraction_type);
    expect(kinds.filter((k) => k === "assent")).toHaveLength(1);
  });

  it("records a tool observation when the primary is not the tool", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
    });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "tool_result",
      role: "tool",
      content: `observed: ${GRAIN}`,
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const kinds = (await sourcesOf(GRAIN)).map((s) => s.extraction_type);
    expect(kinds).toContain("primary");
    expect(kinds).toContain("observation");
    expect(kinds.filter((k) => k === "primary")).toHaveLength(1);
  });

  it("records restatement by a different speaker, not as mentioned-again", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Robin",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const kinds = (await sourcesOf(GRAIN)).map((s) => s.extraction_type);
    expect(kinds).toContain("primary");
    expect(kinds).toContain("restatement");
    expect(kinds).not.toContain("corroborating");
  });

  it("records same-speaker repeats as mentioned-again, not restatement", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: `Again: ${GRAIN}`,
      speaker: "Alex",
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    const kinds = (await sourcesOf(GRAIN)).map((s) => s.extraction_type);
    expect(kinds).toContain("primary");
    expect(kinds).toContain("corroborating");
    expect(kinds).not.toContain("restatement");
  });
});

describe("do not invent people (F)", () => {
  it("does not create Unknown from unattributed turns", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
    });
    await consolidate(db, recording([{ content: GRAIN }]) as never, {
      extraction: { ...DEFAULT_CONFIG.extraction, enabled: true } as never,
    });
    expect(await findEntity(db, "Unknown")).toBeNull();
    const self = await getSelfEntity(db);
    expect(self).toBeTruthy();
  });

  it("still does not mint a person from a display name", async () => {
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
    const uttered = (await db
      .prepare(
        `SELECT fe.entity_id
           FROM fact_entities fe
           JOIN facts f ON f.id = fe.fact_id
          WHERE fe.relationship = ? AND f.content = ?`,
      )
      .all(UTTERED_BY, GRAIN)) as Array<{ entity_id: string }>;
    expect(uttered).toHaveLength(0);
  });
});

describe("optional ranking weights (D)", () => {
  it("ranks a weighted speaker above an unweighted twin", async () => {
    const alex = await insertFact(db, {
      content: "Alex kaleidoscope token prefers dark roast.",
      domain: "pipeline",
      source_type: "explicit",
      speaker: "Alex",
      speaker_role: "user",
    });
    const robin = await insertFact(db, {
      content: "Robin kaleidoscope token prefers light roast.",
      domain: "pipeline",
      source_type: "explicit",
      speaker: "Robin",
      speaker_role: "user",
    });
    const unset = await hybridSearch(db, "kaleidoscope", { limit: 5 });
    expect(unset.results.map((r) => r.fact.id)).toEqual(
      expect.arrayContaining([alex.id, robin.id]),
    );
    const empty = await hybridSearch(db, "kaleidoscope", {
      limit: 5,
      interlocutor: {},
    });
    expect(empty.results.map((r) => r.fact.id)).toEqual(
      unset.results.map((r) => r.fact.id),
    );
    const weighted = await hybridSearch(db, "kaleidoscope", {
      limit: 5,
      interlocutor: { speaker_weights: { Alex: 8, Robin: 0.1 } },
    });
    expect(weighted.results[0]?.fact.id).toBe(alex.id);
    expect(weighted.results.map((r) => r.fact.id).indexOf(alex.id)).toBeLessThan(
      weighted.results.map((r) => r.fact.id).indexOf(robin.id),
    );
  });
});
