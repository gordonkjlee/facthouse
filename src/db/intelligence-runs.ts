/**
 * Persisted billed-intelligence runs. One row per consolidate (or a future
 * capture path that actually invokes a model). Stats aggregates from this
 * table — do not also copy the blob onto `consolidations`.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "./connection.js";
import {
  type IntelligenceRunKind,
  type IntelligenceUsage,
  type StoredIntelligenceRun,
  parseStoredUsage,
} from "../intelligence/usage.js";

function asIso(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

export type IntelligenceRunTrigger = "mcp" | "cli" | "scheduler";

export async function insertIntelligenceRun(
  db: Db,
  opts: {
    kind: IntelligenceRunKind;
    consolidationId?: string | null;
    usage: IntelligenceUsage;
    createdAt?: string;
    trigger?: IntelligenceRunTrigger | null;
    sourceTool?: string | null;
    project?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db
    .prepare(
      `INSERT INTO intelligence_runs
         (id, kind, consolidation_id, created_at, usage, trigger, source_tool, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.kind,
      opts.consolidationId ?? null,
      opts.createdAt ?? new Date().toISOString(),
      JSON.stringify(opts.usage),
      opts.trigger ?? null,
      opts.sourceTool ?? null,
      opts.project ?? null,
    );
  return id;
}

type RunRow = {
  id: string;
  kind: string;
  consolidation_id: string | null;
  created_at: unknown;
  usage: string;
  trigger?: string | null;
  source_tool?: string | null;
  project?: string | null;
};

function mapRunRows(rows: RunRow[]): StoredIntelligenceRun[] {
  const out: StoredIntelligenceRun[] = [];
  for (const row of rows) {
    if (row.kind !== "consolidate" && row.kind !== "capture") continue;
    const usage = parseStoredUsage(row.usage);
    if (!usage) continue;
    out.push({
      id: row.id,
      kind: row.kind as StoredIntelligenceRun["kind"],
      consolidation_id: row.consolidation_id,
      created_at: asIso(row.created_at),
      usage,
      trigger: row.trigger ?? null,
      source_tool: row.source_tool ?? null,
      project: row.project ?? null,
    });
  }
  return out;
}

export async function listIntelligenceRuns(db: Db): Promise<StoredIntelligenceRun[]> {
  const rows = (await db
    .prepare(
      `SELECT id, kind, consolidation_id, created_at, usage, trigger, source_tool, project
         FROM intelligence_runs`,
    )
    .all()) as RunRow[];
  return mapRunRows(rows);
}

export async function listIntelligenceRunsSince(
  db: Db,
  sinceIso: string,
): Promise<StoredIntelligenceRun[]> {
  const rows = (await db
    .prepare(
      `SELECT id, kind, consolidation_id, created_at, usage, trigger, source_tool, project
         FROM intelligence_runs
        WHERE created_at >= ?`,
    )
    .all(sinceIso)) as RunRow[];
  return mapRunRows(rows);
}
