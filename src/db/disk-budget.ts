/**
 * Optional disk ceiling on one brain, and the ingest guard that honours it.
 *
 * Unset = unlimited. The number is SQLite `memory.db` (page count × page
 * size), not event-content bytes. Cap-driven prune uses the existing
 * reachability rule and does not compact. New rows reuse freed pages.
 */

import { pragmaRead, pragmaWrite, type Db } from "./connection.js";
import { pruneEvents, prunableEvents, type PruneStats } from "./prune.js";
import { DEFAULT_CONFIG } from "../types/config.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const TB = 1024 * GB;

const UNIT_BYTES: Record<string, number> = { mb: MB, gb: GB, tb: TB };

export class DiskBudgetError extends Error {
  readonly code = "DISK_BUDGET";
  constructor(message: string) {
    super(message);
    this.name = "DiskBudgetError";
  }
}

export interface DiskBudgetBinding {
  bytes: number;
  keepPerSession: number;
}

const bound = new WeakMap<object, DiskBudgetBinding>();

export function bindDiskBudget(db: Db, state: DiskBudgetBinding | null): void {
  if (state && state.bytes > 0) bound.set(db, state);
  else bound.delete(db);
}

export function getBoundDiskBudget(db: Db): DiskBudgetBinding | null {
  return bound.get(db) ?? null;
}

export function keepPerSessionOf(db: Db): number {
  return getBoundDiskBudget(db)?.keepPerSession ?? DEFAULT_CONFIG.extraction.working_memory_size;
}

/** Parse `2GB` / `512MB` / `1TB`. Empty or omitted is unlimited. */
export function parseDiskBudget(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new DiskBudgetError(diskBudgetInvalidMessage(value));
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*(mb|gb|tb)$/i);
  if (!m) throw new DiskBudgetError(diskBudgetInvalidMessage(value));
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new DiskBudgetError(diskBudgetInvalidMessage(value));
  }
  return Math.round(n * UNIT_BYTES[m[2].toLowerCase()]!);
}

export function formatDiskBudget(bytes: number): string {
  if (bytes >= TB && bytes % TB === 0) return `${bytes / TB} TB`;
  if (bytes >= GB) {
    const gb = bytes / GB;
    return Number.isInteger(gb) || gb >= 10 ? `${trimFloat(gb)} GB` : `${gb.toFixed(1)} GB`;
  }
  if (bytes >= MB / 10) {
    const mb = bytes / MB;
    return Number.isInteger(mb) || mb >= 10 ? `${trimFloat(mb)} MB` : `${mb.toFixed(1)} MB`;
  }
  return `${Math.max(0, Math.round(bytes))} B`;
}

function trimFloat(n: number): string {
  return String(Number(n.toFixed(1)));
}

export function diskBudgetInvalidMessage(value: unknown): string {
  return (
    `Invalid retention.disk_budget ${JSON.stringify(value)}. ` +
    `Use a size like "2GB" or "512MB", or omit it for unlimited.`
  );
}

export function diskBudgetRefusedMessage(opts: {
  budgetBytes: number;
  storeBytes: number | null;
  reclaimable: PruneStats;
}): string {
  const used =
    opts.storeBytes != null ? formatDiskBudget(opts.storeBytes) : "unknown size";
  const cap = formatDiskBudget(opts.budgetBytes);
  const reclaim =
    opts.reclaimable.events > 0
      ? `${opts.reclaimable.events} events still look reclaimable; the file is still at the ceiling.`
      : "Nothing reclaimable remains (facts and recent raw notes are kept).";
  return (
    `Store is at its disk budget (${used} of ${cap}). More raw events were not written. ` +
    `${reclaim} ` +
    `To give space back to the operating system after a lower cap, run ` +
    `openmemory prune --apply --vacuum.`
  );
}

let postgresSizeWarned = false;

export function resetPostgresSizeWarning(): void {
  postgresSizeWarned = false;
}

/**
 * Ceiling on SQLite page count. Never below the current file — SQLite
 * refuses to shrink max_page_count until a human vacuum.
 */
export async function applySqliteDiskBudget(db: Db, budgetBytes: number): Promise<void> {
  if (db.dialect !== "sqlite") return;
  const pageSize = (await pragmaRead(db, "page_size")) || 4096;
  const pageCount = await pragmaRead(db, "page_count");
  const budgetPages = Math.max(1, Math.ceil(budgetBytes / pageSize));
  await pragmaWrite(db, `max_page_count = ${Math.max(pageCount, budgetPages)}`);
}

export async function sqliteStoreBytes(db: Db): Promise<number> {
  const pageSize = (await pragmaRead(db, "page_size")) || 4096;
  const pageCount = await pragmaRead(db, "page_count");
  return pageCount * pageSize;
}

export async function postgresStoreBytes(db: Db): Promise<number | null> {
  try {
    const row = (await db
      .prepare(`SELECT pg_database_size(current_database()) AS bytes`)
      .get()) as { bytes: number | string } | undefined;
    const n = Number(row?.bytes);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    if (!postgresSizeWarned) {
      postgresSizeWarned = true;
      console.error(
        "[openmemory] Could not read Postgres database size; disk budget is not enforced.",
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }
}

export async function storeBytes(db: Db): Promise<number | null> {
  if (db.dialect === "postgres") return postgresStoreBytes(db);
  return sqliteStoreBytes(db);
}

async function sqliteNeedsReclaim(db: Db): Promise<boolean> {
  const max = await pragmaRead(db, "max_page_count");
  const pages = await pragmaRead(db, "page_count");
  const free = await pragmaRead(db, "freelist_count");
  if (max <= 0 || pages < max) return false;
  return free === 0;
}

async function walCheckpoint(db: Db): Promise<void> {
  if (db.dialect !== "sqlite") return;
  await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/**
 * If a cap is set and the store has no room, prune unreachable D then
 * re-check. Throws DiskBudgetError when still full. No VACUUM.
 */
export async function ensureRoomForData(db: Db): Promise<void> {
  const cap = getBoundDiskBudget(db);
  if (!cap) return;

  if (db.dialect === "postgres") {
    const size = await postgresStoreBytes(db);
    if (size == null) return;
    if (size < cap.bytes) return;
    await pruneEvents(db, cap.keepPerSession);
    const after = await postgresStoreBytes(db);
    if (after != null && after >= cap.bytes) {
      throw new DiskBudgetError(
        diskBudgetRefusedMessage({
          budgetBytes: cap.bytes,
          storeBytes: after,
          reclaimable: await prunableEvents(db, cap.keepPerSession),
        }),
      );
    }
    return;
  }

  if (!(await sqliteNeedsReclaim(db))) return;
  await pruneEvents(db, cap.keepPerSession);
  await walCheckpoint(db);
  if (await sqliteNeedsReclaim(db)) {
    throw new DiskBudgetError(
      diskBudgetRefusedMessage({
        budgetBytes: cap.bytes,
        storeBytes: await sqliteStoreBytes(db),
        reclaimable: await prunableEvents(db, cap.keepPerSession),
      }),
    );
  }
}
