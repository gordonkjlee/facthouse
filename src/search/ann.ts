/**
 * When meaning-search may use an HNSW index.
 *
 * Postgres: pgvector sidecar when the `vector` extension is present.
 * SQLite: in-process graph rebuilt from BLOBs. The exact JavaScript scan is
 * the default below the byte threshold and the fallback when the engine is
 * missing. This module is the one definition of that gate and of the warning
 * copy.
 */

import type { Dialect } from "../db/connection.js";
import { ANN_DEFAULT_MAX_BYTES } from "../types/config.js";

export function embeddingWorkingSetBytes(count: number, dimensions: number): number {
  return count * dimensions * 4;
}

/**
 * `enginePresent` is the `vector` extension on Postgres and the in-process
 * engine on SQLite. One flag so the auto / force / off rule is not copied.
 */
export function shouldUseAnn(opts: {
  dialect: Dialect;
  ann: boolean | null | undefined;
  bytes: number;
  maxBytes: number;
  enginePresent: boolean;
}): boolean {
  if (opts.ann === false) return false;
  if (!opts.enginePresent) return false;
  if (opts.ann === true) return true;
  const cap = Number.isFinite(opts.maxBytes) ? opts.maxBytes : ANN_DEFAULT_MAX_BYTES;
  return opts.bytes > cap;
}

/** Would want HNSW if the engine existed (for the missing-engine warning). */
export function wouldWantAnn(opts: {
  dialect: Dialect;
  ann: boolean | null | undefined;
  bytes: number;
  maxBytes: number;
}): boolean {
  if (opts.ann === false) return false;
  if (opts.ann === true) return true;
  const cap = Number.isFinite(opts.maxBytes) ? opts.maxBytes : ANN_DEFAULT_MAX_BYTES;
  return opts.bytes > cap;
}

export function sqliteEngineMissingWarning(): string {
  return (
    "Meaning-search is still exact. The in-process HNSW index could not start; " +
    "using the exact scan."
  );
}

export function postgresMissingVectorWarning(): string {
  return (
    "Meaning-search is still exact. Enable the Postgres vector extension to " +
    "use an HNSW index at this size. OpenMemory did not try to install it."
  );
}

export function postgresHnswFallbackWarning(detail: string): string {
  return `HNSW meaning-search failed (${detail}); using the exact scan.`;
}

const warned = new Set<string>();

export function emitAnnWarningOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[openmemory] ${message}`);
}

/** Test seam so "once" can be asserted without leaking across files. */
export function resetAnnWarningState(): void {
  warned.clear();
}
