/**
 * Gated inferences — hypotheses, not speech.
 *
 * Capture stores a pending row with supporting fact ids. Confirm inserts a
 * graduated fact with source_type "inference". Reject records that it is not
 * knowledge. Consolidate never writes this table.
 */

import { randomUUID } from "node:crypto";
import { withTransaction } from "./connection.js";
import type { Db } from "./connection.js";
import { getFact, insertFact } from "./facts.js";
import { createSource } from "./sources.js";
import type { Fact, Inference, InferenceStatus } from "../types/data.js";

export interface NewInference {
  hypothesis: string;
  evidence_fact_ids: string[];
}

export interface ValidateInference {
  id: string;
  confirmed: boolean;
  reason?: string | null;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

async function loadEvidence(db: Db, inferenceId: string): Promise<string[]> {
  const rows = (await db
    .prepare(
      `SELECT fact_id FROM inference_evidence
        WHERE inference_id = ? ORDER BY fact_id`,
    )
    .all(inferenceId)) as Array<{ fact_id: string }>;
  return rows.map((r) => r.fact_id);
}

function mapInference(
  row: {
    id: string;
    hypothesis: string;
    status: InferenceStatus;
    reason: string | null;
    fact_id: string | null;
    created_at: string;
    validated_at: string | null;
  },
  evidence_fact_ids: string[],
): Inference {
  return {
    id: row.id,
    hypothesis: row.hypothesis,
    status: row.status,
    evidence_fact_ids,
    reason: row.reason,
    fact_id: row.fact_id,
    created_at: row.created_at,
    validated_at: row.validated_at,
  };
}

async function requireFacts(db: Db, ids: string[]): Promise<void> {
  const missing: string[] = [];
  for (const id of ids) {
    if (!(await getFact(db, id))) missing.push(id);
  }
  if (missing.length > 0) {
    throw new Error(
      "Unknown evidence fact id(s): " + missing.join(", ") + ".",
    );
  }
}

/** Store a pending hypothesis. Does not write facts. */
export async function insertInference(
  db: Db,
  input: NewInference,
): Promise<Inference> {
  const hypothesis = input.hypothesis.trim();
  if (!hypothesis) {
    throw new Error("Hypothesis must not be empty.");
  }
  const evidence = uniqueIds(input.evidence_fact_ids);
  if (evidence.length === 0) {
    throw new Error(
      "An inference needs at least one supporting fact id — a hypothesis with no evidence is not a gated invention, it is a guess.",
    );
  }
  await requireFacts(db, evidence);

  const id = randomUUID();
  const now = new Date().toISOString();

  return withTransaction(db, async () => {
    await db
      .prepare(
        `INSERT INTO inferences (id, hypothesis, status, reason, fact_id, created_at, validated_at)
       VALUES (?, ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .run(id, hypothesis, now);
    const link = db.prepare(
      `INSERT INTO inference_evidence (inference_id, fact_id) VALUES (?, ?)`,
    );
    for (const factId of evidence) {
      await link.run(id, factId);
    }
    return mapInference(
      {
        id,
        hypothesis,
        status: "pending",
        reason: null,
        fact_id: null,
        created_at: now,
        validated_at: null,
      },
      evidence,
    );
  });
}

export async function getInference(
  db: Db,
  id: string,
): Promise<Inference | null> {
  const row = (await db
    .prepare(
      `SELECT id, hypothesis, status, reason, fact_id, created_at, validated_at
         FROM inferences WHERE id = ?`,
    )
    .get(id)) as
    | {
        id: string;
        hypothesis: string;
        status: InferenceStatus;
        reason: string | null;
        fact_id: string | null;
        created_at: string;
        validated_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return mapInference(row, await loadEvidence(db, id));
}

export async function listInferences(
  db: Db,
  status: InferenceStatus = "pending",
): Promise<Inference[]> {
  const rows = (await db
    .prepare(
      `SELECT id, hypothesis, status, reason, fact_id, created_at, validated_at
         FROM inferences WHERE status = ? ORDER BY created_at ASC`,
    )
    .all(status)) as Array<{
    id: string;
    hypothesis: string;
    status: InferenceStatus;
    reason: string | null;
    fact_id: string | null;
    created_at: string;
    validated_at: string | null;
  }>;
  const out: Inference[] = [];
  for (const row of rows) {
    out.push(mapInference(row, await loadEvidence(db, row.id)));
  }
  return out;
}

/**
 * Confirm (graduate to K) or reject. Confirming inserts a fact labelled
 * inference; it does not pretend the sentence was said.
 */
export async function validateInference(
  db: Db,
  input: ValidateInference,
): Promise<{ inference: Inference; fact: Fact | null }> {
  return withTransaction(db, async () => {
    const existing = await getInference(db, input.id);
    if (!existing) {
      throw new Error("Unknown inference id " + JSON.stringify(input.id) + ".");
    }
    if (existing.status !== "pending") {
      throw new Error(
        "Inference " +
          existing.id +
          " is already " +
          existing.status +
          "; validate only a pending hypothesis.",
      );
    }

    const now = new Date().toISOString();
    const reason = input.reason?.trim() || null;

    if (!input.confirmed) {
      const result = await db
        .prepare(
          `UPDATE inferences
              SET status = 'rejected', reason = ?, validated_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(reason, now, existing.id);
      if (result.changes === 0) {
        throw new Error("Failed to reject inference " + existing.id + ".");
      }
      return {
        inference: {
          ...existing,
          status: "rejected",
          reason,
          validated_at: now,
        },
        fact: null,
      };
    }

    await requireFacts(db, existing.evidence_fact_ids);

    const source = await createSource(db, {
      type: "inference",
      raw_content: existing.hypothesis,
      metadata: {
        inference_id: existing.id,
        evidence_fact_ids: existing.evidence_fact_ids,
      },
    });

    const fact = await insertFact(db, {
      content: existing.hypothesis,
      // Unclassified bucket — not a shipped vocabulary. Confirm is the gate,
      // not a classifier pass.
      domain: "general",
      source_type: "inference",
      source_id: source.id,
      source_quality: "explicit",
      confidence: 0.5,
      valid_from: null,
    });

    const result = await db
      .prepare(
        `UPDATE inferences
            SET status = 'confirmed', reason = ?, fact_id = ?, validated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(reason, fact.id, now, existing.id);
    if (result.changes === 0) {
      throw new Error("Failed to confirm inference " + existing.id + ".");
    }

    return {
      inference: {
        ...existing,
        status: "confirmed",
        reason,
        fact_id: fact.id,
        validated_at: now,
      },
      fact,
    };
  });
}
