/**
 * Data access for fact embeddings. All functions are synchronous.
 *
 * Two things here carry the whole design.
 *
 * **Vectors are stored as raw `Float32Array` bytes**, not JSON. A 512-dimension
 * vector is 2 KB as a BLOB and roughly 10 KB as a JSON array of decimals, and
 * the scan reads every stored vector on every query — so the encoding is the
 * difference between a page-cache-resident working set and one that is not.
 *
 * **Every row records the model and dimension that produced it.** Vectors from
 * different models are not comparable: cosine similarity between them returns a
 * number, that number is meaningless, and nothing anywhere raises an error. So
 * reads filter on both, and a model change becomes a visible state — facts with
 * no row for the current model — rather than a store that quietly returns
 * nonsense.
 */

import { withTransaction } from "./connection.js";
import type { Db, SqlParam } from "./connection.js";

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Pack a vector into little-endian float32 bytes.
 *
 * Copies rather than aliasing `Float32Array.buffer`: a typed array may be a
 * view onto a larger buffer with a non-zero offset, and handing that buffer
 * straight to SQLite would store whatever else happens to live in it.
 */
export function packVector(vector: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    buf.writeFloatLE(vector[i], i * 4);
  }
  return buf;
}

/** Unpack little-endian float32 bytes back into a vector. */
export function unpackVector(buf: Buffer | Uint8Array): Float32Array {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length % 4 !== 0) {
    throw new Error(`embedding blob length ${b.length} is not a multiple of 4`);
  }
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = b.readFloatLE(i * 4);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface NewEmbedding {
  fact_id: string;
  vector: Float32Array;
}

/**
 * Store embeddings for a batch of facts, replacing any existing row per fact.
 *
 * REPLACE rather than IGNORE because the row is derived data, not a fact: when
 * the model changes, the new vector is the correct one and the old is garbage.
 * The whole batch commits or none of it does, so a crash mid-write cannot leave
 * half a consolidation's facts embedded under one model and half under another.
 */
export function insertEmbeddings(
  db: Db,
  embeddings: NewEmbedding[],
  model: string,
  dimensions: number,
): void {
  if (embeddings.length === 0) return;

  const now = new Date().toISOString();
  withTransaction(db, () => {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO fact_embeddings
         (fact_id, model, dimensions, vector, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const e of embeddings) {
      if (e.vector.length !== dimensions) {
        // A dimension mismatch here would be stored happily and go wrong much
        // later, at read time, as a silently truncated comparison.
        throw new Error(
          `embedding for ${e.fact_id} has ${e.vector.length} dimensions, expected ${dimensions}`,
        );
      }
      stmt.run(e.fact_id, model, dimensions, packVector(e.vector), now);
    }
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface StoredEmbedding {
  fact_id: string;
  vector: Float32Array;
}

/**
 * Every embedding for the given model and dimension.
 *
 * The scan reads all of them — that is what makes it exact, and what makes the
 * working-set size the thing to watch. Filtering happens in SQL so a store
 * holding vectors from a previous model never materialises them.
 */
export function getEmbeddings(
  db: Db,
  model: string,
  dimensions: number,
): StoredEmbedding[] {
  const rows = db
    .prepare(
      `SELECT fact_id, vector FROM fact_embeddings
        WHERE model = ? AND dimensions = ?`,
    )
    .all(model, dimensions) as Array<{ fact_id: string; vector: Uint8Array }>;

  return rows.map((r) => ({
    fact_id: r.fact_id,
    vector: unpackVector(r.vector),
  }));
}

/**
 * Facts that need embedding: currently-true, with no vector for this model.
 *
 * This *is* the retry queue. There is no separate "failed" flag and no
 * bookkeeping to keep in sync — a failed embedding leaves no row, and the
 * absence of the row is what schedules the retry. A model change enqueues the
 * whole store by the same rule, with nothing extra to invalidate.
 */
export function getFactsMissingEmbeddings(
  db: Db,
  model: string,
  dimensions: number,
  limit: number,
): Array<{ id: string; content: string }> {
  return db
    .prepare(
      `SELECT f.id AS id, f.content AS content
         FROM facts f
         LEFT JOIN fact_embeddings e
           ON e.fact_id = f.id AND e.model = ? AND e.dimensions = ?
        WHERE e.fact_id IS NULL
          AND f.status = 'active' AND f.is_latest = 1
        ORDER BY f.created_at DESC
        LIMIT ?`,
    )
    .all(model, dimensions, limit as SqlParam) as Array<{
    id: string;
    content: string;
  }>;
}

/** How many facts carry a vector for this model — coverage, for `get_stats`. */
export function countEmbeddings(
  db: Db,
  model: string,
  dimensions: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fact_embeddings WHERE model = ? AND dimensions = ?`,
    )
    .get(model, dimensions) as { n: number };
  return row.n;
}
