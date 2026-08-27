/**
 * Postgres HNSW sidecar of the active (model, dimensions) embedding set.
 *
 * BLOBs in `fact_embeddings` remain the source of truth. This table is
 * derived, typed `vector(N)`, and never queried for a different model.
 * Created on demand; SQLite never sees it.
 */

import type { Db } from "./connection.js";
import { getEmbeddings, type NewEmbedding } from "./embeddings.js";

export const HNSW_TABLE = "fact_embeddings_hnsw";
const HNSW_META = "fact_embeddings_hnsw_meta";

const extensionCache = new WeakMap<object, boolean>();

export async function hasVectorExtension(db: Db): Promise<boolean> {
  if (db.dialect !== "postgres") return false;
  if (extensionCache.get(db) === true) return true;
  try {
    const row = (await db
      .prepare(`SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'`)
      .get()) as { ok: number } | undefined;
    const present = row !== undefined;
    if (present) extensionCache.set(db, true);
    return present;
  } catch {
    return false;
  }
}

function assertDimension(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 16_000) {
    throw new Error(`HNSW sidecar refuses dimension ${n}`);
  }
  return n;
}

function toVectorLiteral(vector: Float32Array): string {
  let s = "[";
  for (let i = 0; i < vector.length; i++) {
    if (i > 0) s += ",";
    const x = vector[i];
    s += Number.isFinite(x) ? String(x) : "0";
  }
  return s + "]";
}

async function sidecarMeta(
  db: Db,
): Promise<{ model: string; dimensions: number } | null> {
  // Do not SELECT from a missing table inside a write transaction: Postgres
  // aborts the whole transaction, and catching in JavaScript does not undo that.
  const present = (await db
    .prepare(
      `SELECT 1 AS ok FROM information_schema.tables WHERE table_name = ?`,
    )
    .get(HNSW_META)) as { ok: number } | undefined;
  if (!present) return null;
  const row = (await db
    .prepare(`SELECT model, dimensions FROM ${HNSW_META} LIMIT 1`)
    .get()) as { model: string; dimensions: number } | undefined;
  return row ?? null;
}

export async function sidecarIsCurrent(
  db: Db,
  model: string,
  dimensions: number,
): Promise<boolean> {
  const meta = await sidecarMeta(db);
  return meta !== null && meta.model === model && meta.dimensions === dimensions;
}

/**
 * Drop and rebuild the sidecar from BLOBs for this model+dimension.
 * Caller has already checked the `vector` extension.
 */
export async function rebuildHnswSidecar(
  db: Db,
  model: string,
  dimensions: number,
): Promise<void> {
  const n = assertDimension(dimensions);
  const stored = await getEmbeddings(db, model, n);
  await db.exec(`DROP TABLE IF EXISTS ${HNSW_TABLE}`);
  await db.exec(`DROP TABLE IF EXISTS ${HNSW_META}`);
  await db.exec(
    `CREATE TABLE ${HNSW_TABLE} (` +
      `fact_id TEXT PRIMARY KEY,` +
      `embedding vector(${n}) NOT NULL` +
      `)`,
  );
  await db.exec(
    `CREATE INDEX ${HNSW_TABLE}_idx ON ${HNSW_TABLE} ` +
      `USING hnsw (embedding vector_cosine_ops)`,
  );
  await db.exec(
    `CREATE TABLE ${HNSW_META} (` +
      `model TEXT NOT NULL,` +
      `dimensions INTEGER NOT NULL` +
      `)`,
  );
  await db.prepare(`INSERT INTO ${HNSW_META} (model, dimensions) VALUES (?, ?)`).run(
    model,
    n,
  );
  const ins = db.prepare(
    `INSERT INTO ${HNSW_TABLE} (fact_id, embedding) VALUES (?, ?::vector)`,
  );
  for (const row of stored) {
    await ins.run(row.fact_id, toVectorLiteral(row.vector));
  }
}

export async function ensureHnswSidecar(
  db: Db,
  model: string,
  dimensions: number,
): Promise<void> {
  if (await sidecarIsCurrent(db, model, dimensions)) return;
  await rebuildHnswSidecar(db, model, dimensions);
}

/** Keep the sidecar in step when it already exists for this model+dimension. */
export async function syncHnswSidecar(
  db: Db,
  embeddings: NewEmbedding[],
  model: string,
  dimensions: number,
): Promise<void> {
  if (db.dialect !== "postgres") return;
  if (!(await sidecarIsCurrent(db, model, dimensions))) return;
  const ins = db.prepare(
    `INSERT INTO ${HNSW_TABLE} (fact_id, embedding) VALUES (?, ?::vector)` +
      ` ON CONFLICT (fact_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
  );
  for (const e of embeddings) {
    await ins.run(e.fact_id, toVectorLiteral(e.vector));
  }
}

export interface HnswHit {
  id: string;
  score: number;
}

/**
 * Cosine similarity via pgvector `<=>` (cosine *distance* = 1 − similarity
 * for this operator class).
 */
export async function hnswSearchHits(
  db: Db,
  queryVector: Float32Array,
  limit: number,
): Promise<HnswHit[]> {
  const lit = toVectorLiteral(queryVector);
  const rows = (await db
    .prepare(
      `SELECT fact_id AS id, (embedding <=> ?::vector) AS dist` +
        ` FROM ${HNSW_TABLE}` +
        ` ORDER BY embedding <=> ?::vector` +
        ` LIMIT ?`,
    )
    .all(lit, lit, limit)) as Array<{ id: string; dist: number }>;
  return rows.map((r) => ({
    id: r.id,
    score: 1 - Number(r.dist),
  }));
}
