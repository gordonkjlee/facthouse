/**
 * A restatement recorded in a different project corroborates the one fact.
 * It does not create a second fact, and it does not raise confidence.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { insertFact, getFact, getFactsByDomain } = await import("../../src/db/facts.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
const { copySources } = await import("../../src/sources/copy.js");
const { openPgliteDatabase } = await import("../helpers/pglite-store.js");

const LINE = "Alex prefers terse replies.";

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

async function stamp(database: Db, id: string, createdAt: string): Promise<void> {
  await database.prepare(`UPDATE session_facts SET created_at = ? WHERE id = ?`).run(
    createdAt,
    id,
  );
}

async function stage(
  database: Db,
  project: string | null,
  origin: "explicit" | "inferred",
  createdAt: string,
  content = LINE,
) {
  const session = await createSession(database, {
    source_tool: "claude-code",
    project,
  });
  const fact = await insertSessionFact(database, {
    session_id: session.id,
    content,
    domain_hint: "preferences",
    source_origin: origin,
  });
  if (!fact) throw new Error("session fact was not inserted");
  await stamp(database, fact.id, createdAt);
  return { session, fact };
}

async function relationRows(database: Db) {
  return (await database
    .prepare(`SELECT * FROM fact_relations ORDER BY created_at, id`)
    .all()) as Array<{
    kind: string;
    fact_id: string;
    related_fact_id: string | null;
    session_fact_id: string;
    context_verdict: string;
    reason: string;
    fact_project: string | null;
    candidate_project: string | null;
  }>;
}

describe("restatement in one batch", () => {
  it("keeps the explicit fact and corroborates the other project", async () => {
    const inferred = await stage(db, "C--dev-work", "inferred", "2020-01-01T00:00:00.000Z");
    const explicit = await stage(db, "C--dev-home", "explicit", "2024-06-01T00:00:00.000Z");
    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.factsIntegrated).toBe(1);
    expect(result.factsRejected).toBe(1);
    expect(result.corroborations).toBe(1);
    const facts = await getFactsByDomain(db, "preferences");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.session_id).toBe(explicit.session.id);
    expect(facts[0]?.confidence).toBeCloseTo(0.7);
    const rows = await relationRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "corroborated_by",
      fact_id: facts[0]?.id,
      related_fact_id: null,
      session_fact_id: inferred.fact.id,
      context_verdict: "different",
      fact_project: "C--dev-home",
      candidate_project: "C--dev-work",
    });
  });

  it("keeps the earlier fact when both were explicit", async () => {
    const early = await stage(db, "C--dev-work", "explicit", "2020-01-01T00:00:00.000Z");
    await stage(db, "C--dev-home", "explicit", "2024-06-01T00:00:00.000Z");
    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.factsIntegrated).toBe(1);
    expect(result.corroborations).toBe(1);
    const facts = await getFactsByDomain(db, "preferences");
    expect(facts[0]?.session_id).toBe(early.session.id);
  });

  it("writes no row for a same-project sibling", async () => {
    await stage(db, "C--dev-work", "explicit", "2020-01-01T00:00:00.000Z");
    await stage(db, "C--dev-work", "inferred", "2024-06-01T00:00:00.000Z");
    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.factsIntegrated).toBe(1);
    expect(result.factsRejected).toBe(1);
    expect(result.corroborations).toBe(0);
    expect(await relationRows(db)).toHaveLength(0);
  });

  it("writes no row when a project is null or only numeric", async () => {
    await stage(db, null, "explicit", "2020-01-01T00:00:00.000Z");
    await stage(db, "C--dev-home", "explicit", "2024-06-01T00:00:00.000Z");
    const first = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(first.corroborations).toBe(0);
    expect(await relationRows(db)).toHaveLength(0);

    await stage(db, "12345", "explicit", "2020-01-02T00:00:00.000Z", "Robin keeps the staging key.");
    await stage(db, "C--dev-home", "explicit", "2024-07-01T00:00:00.000Z", "Robin keeps the staging key.");
    const second = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(second.corroborations).toBe(0);
    expect(await relationRows(db)).toHaveLength(0);
  });
});

async function laterTwin(database: Db): Promise<void> {
  const work = await createSession(database, {
    source_tool: "claude-code",
    project: "C--dev-work",
  });
  await insertSessionFact(database, {
    session_id: work.id,
    content: LINE,
    domain_hint: "preferences",
  });
  const first = await consolidate(database, createHeuristicProvider(PERSONAL_VOCABULARY));
  expect(first.factsIntegrated).toBe(1);
  const prior = (await getFactsByDomain(database, "preferences"))[0];
  expect(prior).toBeTruthy();

  const home = await createSession(database, {
    source_tool: "claude-code",
    project: "C--dev-home",
  });
  const twin = await insertSessionFact(database, {
    session_id: home.id,
    content: LINE,
    domain_hint: "preferences",
  });
  const second = await consolidate(database, createHeuristicProvider(PERSONAL_VOCABULARY));
  expect(second.factsIntegrated).toBe(0);
  expect(second.factsRejected).toBe(1);
  expect(second.corroborations).toBe(1);
  const rows = await relationRows(database);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "corroborated_by",
    fact_id: prior?.id,
    related_fact_id: null,
    session_fact_id: twin?.id,
    context_verdict: "different",
  });
  expect((await getFact(database, prior!.id))?.confidence).toBeCloseTo(0.7);
}

async function enrichParaphrase(database: Db): Promise<void> {
  const work = await createSession(database, {
    source_tool: "claude-code",
    project: "C--dev-work",
  });
  const prior = await insertFact(database, {
    content: LINE,
    domain: "preferences",
    source_type: "conversation",
    session_id: work.id,
    confidence: 0.4,
  });
  const home = await createSession(database, {
    source_tool: "claude-code",
    project: "C--dev-home",
  });
  const paraphrase = await insertSessionFact(database, {
    session_id: home.id,
    content: "Alex likes terse replies.",
    domain_hint: "preferences",
  });
  const provider = {
    ...createHeuristicProvider(PERSONAL_VOCABULARY),
    async reconcile() {
      return { kind: "enrich" as const, existingFactId: prior.id };
    },
  };
  const result = await consolidate(database, provider);
  expect(result.factsIntegrated).toBe(0);
  expect(result.corroborations).toBe(1);
  expect((await getFact(database, prior.id))?.confidence).toBeCloseTo(0.5);
  const rows = await relationRows(database);
  expect(rows.find((row) => row.reason === "paraphrase (enrich)")).toMatchObject({
    kind: "corroborated_by",
    fact_id: prior.id,
    related_fact_id: null,
    session_fact_id: paraphrase?.id,
    reason: "paraphrase (enrich)",
  });
}

describe("restatement of an integrated fact", () => {
  it("corroborates on a later run without raising confidence", async () => {
    await laterTwin(db);
  });

  it("records an enrich paraphrase and keeps the confidence bump", async () => {
    await enrichParaphrase(db);
  });

  it("does the same on Postgres", async () => {
    const pg = await openPgliteDatabase();
    try {
      await laterTwin(pg);
      await enrichParaphrase(pg);
    } finally {
      await closeDatabase(pg);
    }
  }, 60_000);
});

describe("copied transcripts", () => {
  it("keeps both preference statements after two consolidations", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "om-prov-"));
    try {
      const home = path.join(root, ".claude");
      const write = (group: string, id: string, content: string) => {
        const file = path.join(home, "projects", group, `${id}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          JSON.stringify({
            type: "user",
            sessionId: id,
            timestamp: "2026-01-01T12:00:00Z",
            message: { role: "user", content },
          }) + "\n",
          "utf8",
        );
      };
      const provider = {
        ...createHeuristicProvider(PERSONAL_VOCABULARY),
        async extractFactsFromEvents(events: Array<{ role?: string; content?: string | null }>) {
          return {
            facts: events
              .filter((event) => event.role === "user" && event.content)
              .map((event) => ({
                content: event.content as string,
                domain_hint: "preferences",
              })),
            degraded: false,
          };
        },
        async detectSupersession(
          _newFact: { content: string },
          existing: Array<{ id: string; content: string }>,
        ) {
          const prior = existing.find((fact) => fact.content !== _newFact.content);
          if (!prior) return null;
          return {
            existingFactId: prior.id,
            reason: "both can hold",
            basis: "coexists" as const,
            source_quality: "cli" as const,
          };
        },
      };
      const config = { extraction: { enabled: true } };

      write("C--dev-work", "work-1", "Alex prefers terse replies.");
      await copySources(db, [{ kind: "claude-code", home }]);
      const workRun = await consolidate(db, provider, config as never);
      expect(workRun.factsIntegrated).toBe(1);

      write("C--dev-home", "home-1", "Alex prefers detailed replies.");
      await copySources(db, [{ kind: "claude-code", home }]);
      const homeRun = await consolidate(db, provider, config as never);
      expect(homeRun.factsIntegrated).toBe(1);
      expect(homeRun.keptAlongside).toBe(1);
      const rows = await relationRows(db);
      expect(rows.find((row) => row.kind === "kept_alongside")).toMatchObject({
        context_verdict: "different",
        basis: "coexists",
        fact_project: "C--dev-home",
        candidate_project: "C--dev-work",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
