/**
 * Context-aware supersession. The project a fact was recorded in is evidence
 * for the decision. It does not remove a candidate from the domain pool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Db } from "../../src/db/connection.js";
import type { SupersessionBasis, SupersessionContext } from "../../src/intelligence/types.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSession } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { insertFact, getFact } = await import("../../src/db/facts.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
const { createHttpProvider } = await import("../../src/intelligence/http.js");

const TERSE = "Alex prefers terse replies.";
const DETAILED = "Alex prefers detailed replies.";
const MISSING = "The stg_orders relation is missing booked_at.";
const PRESENT = "The stg_orders relation is no longer missing booked_at.";

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

interface Seeded {
  priorId: string;
}

async function seed(opts: {
  priorProject: string | null;
  nextProject: string | null;
  priorContent: string;
  nextContent: string;
  domain: string;
}): Promise<Seeded> {
  const priorSession = await createSession(db, {
    source_tool: "claude-code",
    project: opts.priorProject,
  });
  const nextSession = await createSession(db, {
    source_tool: "claude-code",
    project: opts.nextProject,
  });
  const prior = await insertFact(db, {
    content: opts.priorContent,
    domain: opts.domain,
    source_type: "conversation",
    session_id: priorSession.id,
  });
  await insertSessionFact(db, {
    session_id: nextSession.id,
    content: opts.nextContent,
    domain_hint: opts.domain,
  });
  return { priorId: prior.id };
}

function scripted(
  priorId: string,
  reply: { basis?: SupersessionBasis } | null,
  seen: { verdict?: string },
) {
  const base = createHeuristicProvider(PERSONAL_VOCABULARY);
  return {
    ...base,
    async detectSupersession(
      _newFact: unknown,
      _existing: unknown,
      context?: SupersessionContext,
    ) {
      seen.verdict = context?.verdicts.get(priorId);
      if (context) context.answeredBy = "cli";
      if (reply == null) return null;
      return {
        existingFactId: priorId,
        reason: reply.basis ?? "no basis given",
        ...(reply.basis ? { basis: reply.basis } : {}),
        source_quality: "cli" as const,
      };
    },
  };
}

async function rows() {
  return (await db
    .prepare(`SELECT * FROM fact_relations ORDER BY created_at, id`)
    .all()) as Array<{
    kind: string;
    fact_id: string;
    related_fact_id: string | null;
    context_verdict: string;
    basis: string | null;
    reason: string;
    decided_by: string | null;
    fact_project: string | null;
    candidate_project: string | null;
  }>;
}

describe("contextual pair", () => {
  async function run(reply: { basis?: SupersessionBasis } | null) {
    const seeded = await seed({
      priorProject: "C--dev-work",
      nextProject: "C--dev-home",
      priorContent: TERSE,
      nextContent: DETAILED,
      domain: "preferences",
    });
    const seen: { verdict?: string } = {};
    const result = await consolidate(db, scripted(seeded.priorId, reply, seen));
    const prior = await getFact(db, seeded.priorId);
    return { result, seen, prior, relations: await rows() };
  }

  it("keeps both when the provider says coexists", async () => {
    const { result, seen, prior, relations } = await run({ basis: "coexists" });
    expect(seen.verdict).toBe("different");
    expect(result.supersessions).toBe(0);
    expect(result.keptAlongside).toBe(1);
    expect(prior?.status).toBe("active");
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      kind: "kept_alongside",
      related_fact_id: prior?.id,
      context_verdict: "different",
      basis: "coexists",
      decided_by: "cli",
      fact_project: "C--dev-home",
      candidate_project: "C--dev-work",
    });
  });

  it("keeps both when a different-project hit has no basis and no marker", async () => {
    const { result, seen, prior, relations } = await run({});
    expect(seen.verdict).toBe("different");
    expect(result.supersessions).toBe(0);
    expect(prior?.status).toBe("active");
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      kind: "kept_alongside",
      basis: null,
      decided_by: "cli",
      context_verdict: "different",
    });
  });

  it("notes the overlap when the provider proposes nothing", async () => {
    const { result, seen, prior, relations } = await run(null);
    expect(seen.verdict).toBe("different");
    expect(result.supersessions).toBe(0);
    expect(result.keptAlongside).toBe(0);
    expect(prior?.status).toBe("active");
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      kind: "overlap_noted",
      basis: null,
      decided_by: "cli",
      context_verdict: "different",
    });
    expect(relations[0]?.reason).toMatch(/no supersession proposed; overlap \d+%/);
    expect(relations[0]?.reason).not.toContain("lexical trigger");
  });

  it("still declines coexists when both facts were recorded in one project", async () => {
    const seeded = await seed({
      priorProject: "C--dev-work",
      nextProject: "C--dev-work",
      priorContent: TERSE,
      nextContent: DETAILED,
      domain: "preferences",
    });
    const seen: { verdict?: string } = {};
    const result = await consolidate(
      db,
      scripted(seeded.priorId, { basis: "coexists" }, seen),
    );
    expect(seen.verdict).toBe("same");
    expect(result.supersessions).toBe(0);
    expect((await getFact(db, seeded.priorId))?.status).toBe("active");
    const relations = await rows();
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      kind: "kept_alongside",
      context_verdict: "same",
      basis: "coexists",
    });
  });

  it("supersedes a null-project sibling the way a store with no project does", async () => {
    const seeded = await seed({
      priorProject: null,
      nextProject: "C--dev-work",
      priorContent: MISSING,
      nextContent: PRESENT,
      domain: "pipeline",
    });
    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.supersessions).toBe(1);
    expect((await getFact(db, seeded.priorId))?.status).toBe("superseded");
    const relations = await rows();
    expect(relations.filter((row) => row.kind === "supersedes")).toHaveLength(1);
    expect(relations.find((row) => row.kind === "supersedes")).toMatchObject({
      context_verdict: "not_comparable",
      decided_by: "heuristic",
    });
  });

  it("records not_comparable when neither session has a project", async () => {
    const seeded = await seed({
      priorProject: null,
      nextProject: null,
      priorContent: MISSING,
      nextContent: PRESENT,
      domain: "pipeline",
    });
    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.supersessions).toBe(1);
    expect((await getFact(db, seeded.priorId))?.status).toBe("superseded");
    expect((await rows())[0]).toMatchObject({
      kind: "supersedes",
      context_verdict: "not_comparable",
    });
  });
});

describe("shared artefact across projects", () => {
  async function artefact(
    make: (priorId: string) => ReturnType<typeof scripted> | ReturnType<typeof createHeuristicProvider>,
  ) {
    const seeded = await seed({
      priorProject: "C--dev-work",
      nextProject: "C--dev-home",
      priorContent: MISSING,
      nextContent: PRESENT,
      domain: "pipeline",
    });
    const result = await consolidate(db, make(seeded.priorId));
    return {
      seeded,
      result,
      prior: await getFact(db, seeded.priorId),
      relations: await rows(),
    };
  }

  it("supersedes when the basis is update", async () => {
    const seen: { verdict?: string } = {};
    const { result, prior, relations } = await artefact((priorId) =>
      scripted(priorId, { basis: "update" }, seen),
    );
    expect(seen.verdict).toBe("different");
    expect(result.supersessions).toBe(1);
    expect(prior?.status).toBe("superseded");
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      kind: "supersedes",
      basis: "update",
      context_verdict: "different",
      decided_by: "cli",
      fact_id: prior?.superseded_by,
      related_fact_id: prior?.id,
    });
  });

  it("supersedes when the basis is absent and the marker is present", async () => {
    const seen: { verdict?: string } = {};
    const { result, prior, relations } = await artefact((priorId) =>
      scripted(priorId, {}, seen),
    );
    expect(result.supersessions).toBe(1);
    expect(prior?.status).toBe("superseded");
    expect(relations[0]).toMatchObject({
      kind: "supersedes",
      basis: null,
      context_verdict: "different",
      decided_by: "cli",
    });
  });

  it("supersedes on the heuristic and records the overlap in the reason", async () => {
    const { result, prior, relations } = await artefact(() =>
      createHeuristicProvider(PERSONAL_VOCABULARY),
    );
    expect(result.supersessions).toBe(1);
    expect(prior?.status).toBe("superseded");
    const row = relations.find((item) => item.kind === "supersedes");
    expect(row).toMatchObject({
      decided_by: "heuristic",
      context_verdict: "different",
      basis: "update",
      fact_id: prior?.superseded_by,
      related_fact_id: prior?.id,
    });
    expect(row?.reason).toContain("80%");
  });

  it("counts every supersession this run wrote", async () => {
    const runStart = new Date().toISOString();
    const { result } = await artefact(() => createHeuristicProvider(PERSONAL_VOCABULARY));
    const joined = (await db
      .prepare(
        `SELECT n.id AS new_id, o.id AS old_id
           FROM facts o
           JOIN facts n ON n.id = o.superseded_by
          WHERE n.created_at >= ?`,
      )
      .all(runStart)) as Array<{ new_id: string; old_id: string }>;
    const recorded = (await rows()).filter(
      (row) => row.kind === "supersedes",
    );
    expect(recorded).toHaveLength(result.supersessions);
    expect(joined).toHaveLength(recorded.length);
    const pairs = joined
      .map((row) => `${row.new_id}:${row.old_id}`)
      .sort();
    expect(recorded.map((row) => `${row.fact_id}:${row.related_fact_id}`).sort()).toEqual(
      pairs,
    );
  });
});

describe("an explicit coexists wins over the marker", () => {
  it("keeps the pair when the provider says coexists", async () => {
    const seeded = await seed({
      priorProject: "C--dev-work",
      nextProject: "C--dev-home",
      priorContent: MISSING,
      nextContent: PRESENT,
      domain: "pipeline",
    });
    const seen: { verdict?: string } = {};
    const result = await consolidate(
      db,
      scripted(seeded.priorId, { basis: "coexists" }, seen),
    );
    expect(result.supersessions).toBe(0);
    expect(result.keptAlongside).toBe(1);
    expect((await getFact(db, seeded.priorId))?.status).toBe("active");
    expect((await rows())[0]).toMatchObject({
      kind: "kept_alongside",
      basis: "coexists",
      context_verdict: "different",
    });
  });

  it("supersedes the same pair on the heuristic", async () => {
    const seeded = await seed({
      priorProject: "C--dev-work",
      nextProject: "C--dev-home",
      priorContent: MISSING,
      nextContent: PRESENT,
      domain: "pipeline",
    });
    const result = await consolidate(db, createHeuristicProvider(PERSONAL_VOCABULARY));
    expect(result.supersessions).toBe(1);
    expect((await getFact(db, seeded.priorId))?.status).toBe("superseded");
    expect((await rows())[0]?.decided_by).toBe("heuristic");
  });
});

describe("malformed provider JSON", () => {
  it("falls back to the heuristic for both pairs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const work = await createSession(db, {
      source_tool: "claude-code",
      project: "C--dev-work",
    });
    const home = await createSession(db, {
      source_tool: "claude-code",
      project: "C--dev-home",
    });
    const artefact = await insertFact(db, {
      content: MISSING,
      domain: "pipeline",
      source_type: "conversation",
      session_id: work.id,
    });
    const preference = await insertFact(db, {
      content: TERSE,
      domain: "preferences",
      source_type: "conversation",
      session_id: work.id,
    });
    await insertSessionFact(db, {
      session_id: home.id,
      content: PRESENT,
      domain_hint: "pipeline",
    });
    await insertSessionFact(db, {
      session_id: home.id,
      content: DETAILED,
      domain_hint: "preferences",
    });

    const provider = createHttpProvider(
      {
        model: "local-test",
        fetch: async () => ({
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              choices: [{ message: { content: "not-json{" } }],
            });
          },
        }),
      },
      createHeuristicProvider(PERSONAL_VOCABULARY),
    );
    const result = await consolidate(db, provider);
    err.mockRestore();

    expect(result.supersessions).toBe(1);
    expect((await getFact(db, artefact.id))?.status).toBe("superseded");
    expect((await getFact(db, preference.id))?.status).toBe("active");
    const relations = await rows();
    expect(relations.find((row) => row.kind === "supersedes")).toMatchObject({
      decided_by: "heuristic",
      related_fact_id: artefact.id,
    });
    expect(relations.find((row) => row.kind === "overlap_noted")).toMatchObject({
      decided_by: "heuristic",
      related_fact_id: preference.id,
      context_verdict: "different",
    });
  });
});
