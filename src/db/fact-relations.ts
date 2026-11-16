/**
 * Record of a supersession decision.
 *
 * One row per decision made while integrating a fact: a supersession, a
 * pair kept alongside, a later corroboration, or an overlap nobody
 * proposed. The project values are the raw strings the sessions were
 * recorded with. They are evidence on the row, not a filter.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "./connection.js";
import { getProjectsForSessions } from "./sessions.js";
import { projectKey } from "../sources/resolve.js";
import type {
  ContextVerdict,
  FactRelationKind,
  SupersessionBasis,
} from "../types/data.js";

/** How many fact ids one `IN` lookup binds. */
const RELATION_LOOKUP_CHUNK = 500;

/**
 * Every kind, named once outside the declaration in `types/data.ts` so a
 * kind that nothing can write is visible to the dormant-declaration check.
 * `corroborated_by` is written when a restatement is recognised.
 */
const KIND_RECORDED: Record<FactRelationKind, true> = {
  "supersedes": true,
  "kept_alongside": true,
  "corroborated_by": true,
  "overlap_noted": true,
};

export interface FactRelation {
  id: string;
  consolidation_id: string;
  fact_id: string;
  related_fact_id: string | null;
  session_fact_id: string;
  kind: FactRelationKind;
  context_verdict: ContextVerdict;
  fact_project: string | null;
  candidate_project: string | null;
  basis: SupersessionBasis | null;
  reason: string;
  decided_by: string | null;
  created_at: string;
}

export interface NewFactRelation {
  consolidationId: string;
  factId: string;
  relatedFactId: string | null;
  sessionFactId: string;
  kind: FactRelationKind;
  contextVerdict: ContextVerdict;
  factProject: string | null;
  candidateProject: string | null;
  basis: SupersessionBasis | null;
  reason: string;
  decidedBy: string | null;
}

/** Insert one decision. A fresh id every time — never replace a prior row. */
export async function insertFactRelation(
  db: Db,
  row: NewFactRelation,
): Promise<FactRelation> {
  if (!KIND_RECORDED[row.kind]) {
    throw new Error(`unknown fact relation kind ${row.kind}`);
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.prepare(
    `INSERT INTO fact_relations
       (id, consolidation_id, fact_id, related_fact_id, session_fact_id,
        kind, context_verdict, fact_project, candidate_project, basis,
        reason, decided_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.consolidationId,
    row.factId,
    row.relatedFactId,
    row.sessionFactId,
    row.kind,
    row.contextVerdict,
    row.factProject,
    row.candidateProject,
    row.basis,
    row.reason,
    row.decidedBy,
    createdAt,
  );
  return {
    id,
    consolidation_id: row.consolidationId,
    fact_id: row.factId,
    related_fact_id: row.relatedFactId,
    session_fact_id: row.sessionFactId,
    kind: row.kind,
    context_verdict: row.contextVerdict,
    fact_project: row.factProject,
    candidate_project: row.candidateProject,
    basis: row.basis,
    reason: row.reason,
    decided_by: row.decidedBy,
    created_at: createdAt,
  };
}

/**
 * Relations whose `fact_id` is one of `ids`.
 *
 * One `SELECT` per chunk of {@link RELATION_LOOKUP_CHUNK}. Ids with no row
 * are absent. Order within an id is `created_at`, then `id`.
 */
/** The decision fields a reader shows next to a fact. */
export interface FactDecisionView {
  kind: FactRelationKind;
  related_fact_id: string | null;
  context_verdict: ContextVerdict;
  basis: SupersessionBasis | null;
  reason: string;
}

export function factDecisionView(row: FactRelation): FactDecisionView {
  return {
    kind: row.kind,
    related_fact_id: row.related_fact_id,
    context_verdict: row.context_verdict,
    basis: row.basis,
    reason: row.reason,
  };
}

/** Decisions for these fact ids, one batched read. Ids with none are absent. */
export async function decisionsByFactId(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, FactDecisionView[]>> {
  const rows = await getFactRelationsFor(db, ids);
  const out = new Map<string, FactDecisionView[]>();
  for (const [id, list] of rows) out.set(id, list.map(factDecisionView));
  return out;
}

/**
 * Short key for the place each fact was recorded, keyed by fact id.
 * Null when the stored value carries no cwd. Not a rank input.
 */
export async function recordedInByFactId(
  db: Db,
  facts: ReadonlyArray<{ id: string; session_id: string | null }>,
): Promise<Map<string, string | null>> {
  const sessionIds = [
    ...new Set(
      facts.map((fact) => fact.session_id).filter((id): id is string => !!id),
    ),
  ];
  const bySession = await getProjectsForSessions(db, sessionIds);
  const out = new Map<string, string | null>();
  for (const fact of facts) {
    const raw = fact.session_id ? (bySession.get(fact.session_id) ?? null) : null;
    out.set(fact.id, projectKey(raw));
  }
  return out;
}

export async function getFactRelationsFor(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, FactRelation[]>> {
  const out = new Map<string, FactRelation[]>();
  for (let offset = 0; offset < ids.length; offset += RELATION_LOOKUP_CHUNK) {
    const chunk = ids.slice(offset, offset + RELATION_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = (await db
      .prepare(
        `SELECT * FROM fact_relations
          WHERE fact_id IN (${placeholders})
          ORDER BY created_at, id`,
      )
      .all(...chunk)) as FactRelation[];
    for (const row of rows) {
      const list = out.get(row.fact_id);
      if (list) list.push(row);
      else out.set(row.fact_id, [row]);
    }
  }
  return out;
}
