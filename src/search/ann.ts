/**
 * When meaning-search may use an HNSW sidecar on Postgres.
 *
 * SQLite never does. The exact JavaScript scan is the default and the
 * fallback. This module is the one definition of that gate and of the
 * warning copy.
 */

import type { Dialect } from "../db/connection.js";
import { ANN_DEFAULT_MAX_BYTES } from "../types/config.js";

export function embeddingWorkingSetBytes(count: number, dimensions: number): number {
  return count * dimensions * 4;
}

export function shouldUseAnn(opts: {
  dialect: Dialect;
  ann: boolean | null | undefined;
  bytes: number;
  maxBytes: number;
  extensionPresent: boolean;
}): boolean {
  if (opts.dialect !== "postgres") return false;
  if (opts.ann === false) return false;
  if (!opts.extensionPresent) return false;
  if (opts.ann === true) return true;
  const cap = Number.isFinite(opts.maxBytes) ? opts.maxBytes : ANN_DEFAULT_MAX_BYTES;
  return opts.bytes > cap;
}

/** Would want HNSW if the extension existed (for the missing-extension warning). */
export function wouldWantAnn(opts: {
  dialect: Dialect;
  ann: boolean | null | undefined;
  bytes: number;
  maxBytes: number;
}): boolean {
  if (opts.dialect !== "postgres") return false;
  if (opts.ann === false) return false;
  if (opts.ann === true) return true;
  const cap = Number.isFinite(opts.maxBytes) ? opts.maxBytes : ANN_DEFAULT_MAX_BYTES;
  return opts.bytes > cap;
}

export function sqliteScaleWarning(): string {
  return (
    "Meaning-search is still exact and will get slower as this SQLite store " +
    "grows. Postgres is the scale path (enable the vector extension there " +
    "for an HNSW index). OpenMemory does not copy memory.db for you."
  );
}

export function postgresMissingVectorWarning(): string {
  return (
    "Meaning-search is still exact. Enable the Postgres vector extension to " +
    "use an HNSW index at this size. OpenMemory did not try to install it."
  );
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
