/**
 * One consolidation writes the store at a time.
 *
 * The lease is a single row. `started_at` is when this run took it.
 * `heartbeat_at` is the last time the holder showed it was still alive.
 * A holder refreshes that timestamp on a timer, including across a long
 * model call, and again at each extract batch boundary. Another run may
 * take the row only when the lease is older than STALE_LOCK_MS, and only
 * by a compare-and-swap on the holder and the lease timestamp.
 *
 * Postgres also takes a session advisory lock on a connection kept open
 * for the whole run. Session locks do not survive a pool, so this is not
 * a query on the shared client. The lock disappears when that connection
 * drops. SQLite, and an in-process Postgres with only one session, use
 * the lease alone.
 */

import { onDatabaseClose, withTransaction } from "./connection.js";
import type { Db } from "./connection.js";
import { postgresSessionOpener } from "./postgres.js";
import type { PostgresBackend } from "./postgres.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LockState {
  holder: string;
  /** When this run took the lease. Heartbeats do not move it. */
  started_at: string;
  /**
   * Last heartbeat. Null on a row written before heartbeats existed;
   * the lease is then `started_at`.
   */
  heartbeat_at: string | null;
}

export interface LockHeartbeat {
  /** Stop the timer. Does not release the lease. */
  stop(): void;
  /** True once a refresh saw that this holder no longer owns the row. */
  lost(): boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How often the holder refreshes the lease while the run is alive.
 * Timer-driven, so a single long model call still counts as alive.
 */
export const LOCK_HEARTBEAT_MS = 30_000;

/**
 * A lease older than this may be taken. Four heartbeats: one missed
 * refresh is not a dead run.
 */
export const STALE_LOCK_MS = 2 * 60 * 1000;

/**
 * `pg_try_advisory_lock` / `pg_advisory_unlock` key. One consolidation
 * per database. Fits in a JS safe integer so the driver does not round it.
 */
export const CONSOLIDATION_ADVISORY_LOCK_KEY = 7_483_921_654_032_211;

/** Skip reason when a refresh finds the row is no longer ours. */
export const LOCK_LOST_REASON = "Lost the consolidation lock and stopped.";

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

interface Beat {
  timer: ReturnType<typeof setInterval>;
  lost: boolean;
}

interface AdvisoryHold {
  holder: string;
  session: PostgresBackend;
}

const beats = new WeakMap<object, Map<string, Beat>>();
const advisoryByDb = new WeakMap<object, AdvisoryHold>();
const closeWatch = new WeakSet<object>();

function beatsFor(db: object): Map<string, Beat> {
  let map = beats.get(db);
  if (!map) {
    map = new Map();
    beats.set(db, map);
  }
  return map;
}

function stopBeat(db: object, holder: string): void {
  const map = beats.get(db);
  const beat = map?.get(holder);
  if (!beat) return;
  clearInterval(beat.timer);
  map!.delete(holder);
}

function watchClose(db: Db): void {
  if (closeWatch.has(db)) return;
  closeWatch.add(db);
  onDatabaseClose(db, async () => {
    const map = beats.get(db);
    if (map) {
      for (const holder of [...map.keys()]) stopBeat(db, holder);
    }
    const hold = advisoryByDb.get(db);
    if (hold) await releaseAdvisory(db, hold.holder);
  });
}

/**
 * Refresh the lease every LOCK_HEARTBEAT_MS until `stop`, `releaseLock`,
 * or the database closes. The timer is unref'd so it cannot keep the
 * process alive after the run has finished.
 */
export function startLockHeartbeat(db: Db, holder: string): LockHeartbeat {
  watchClose(db);
  stopBeat(db, holder);
  const beat: Beat = {
    timer: setInterval(() => {
      void refreshLock(db, holder).then(
        (ok) => {
          if (!beats.get(db)?.get(holder)) return;
          if (!ok) {
            beat.lost = true;
            stopBeat(db, holder);
          }
        },
        () => {
          // A closed database or a dropped connection. The next ownership
          // check reads the row and stops the run if the lease is gone.
        },
      );
    }, LOCK_HEARTBEAT_MS),
    lost: false,
  };
  if (typeof beat.timer.unref === "function") beat.timer.unref();
  beatsFor(db).set(holder, beat);
  return {
    stop() {
      stopBeat(db, holder);
    },
    lost() {
      return beat.lost;
    },
  };
}

/**
 * Self-fence. `UPDATE ... WHERE id = 1 AND holder = ?`.
 * Zero rows means this run lost the lease and must not write again.
 */
export async function refreshLock(db: Db, holder: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE consolidation_lock SET heartbeat_at = ?
       WHERE id = 1 AND holder = ?`,
    )
    .run(now, holder);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Advisory lock (Postgres session)
// ---------------------------------------------------------------------------

type AdvisoryOutcome = "na" | "busy" | "held" | "acquired";

function isPgTrue(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true";
}

async function releaseAdvisory(db: object, holder: string): Promise<void> {
  const hold = advisoryByDb.get(db);
  if (!hold || hold.holder !== holder) return;
  advisoryByDb.delete(db);
  try {
    await hold.session.query(`SELECT pg_advisory_unlock($1::bigint)`, [
      CONSOLIDATION_ADVISORY_LOCK_KEY,
    ]);
  } catch {
    // Dropping the session releases a session lock either way.
  }
  await hold.session.close().catch(() => undefined);
}

/**
 * Take the advisory lock on a dedicated session before the row is touched.
 * `acquired` means this call opened that session and must release it if
 * the row lease is not ours. `held` means this process already has it.
 */
async function holdAdvisory(db: Db, holder: string): Promise<AdvisoryOutcome> {
  const existing = advisoryByDb.get(db);
  if (existing) return existing.holder === holder ? "held" : "busy";

  const open = postgresSessionOpener(db);
  if (!open) return "na";

  const session = await open();
  try {
    const result = await session.query(
      `SELECT pg_try_advisory_lock($1::bigint) AS locked`,
      [CONSOLIDATION_ADVISORY_LOCK_KEY],
    );
    if (!isPgTrue(result.rows[0]?.locked)) {
      await session.close().catch(() => undefined);
      return "busy";
    }
  } catch (err) {
    await session.close().catch(() => undefined);
    throw err;
  }
  advisoryByDb.set(db, { holder, session });
  watchClose(db);
  return "acquired";
}

// ---------------------------------------------------------------------------
// Lease row
// ---------------------------------------------------------------------------

interface LeaseRow {
  holder: string;
  started_at: string;
  heartbeat_at: string | null;
}

function leaseAt(row: LeaseRow): string {
  return row.heartbeat_at ?? row.started_at;
}

async function writeLease(db: Db, holder: string): Promise<boolean> {
  const now = new Date().toISOString();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO consolidation_lock
         (id, holder, started_at, heartbeat_at)
       VALUES (1, ?, ?, ?)`,
    )
    .run(holder, now, now);
  if (inserted.changes > 0) return true;

  const existing = (await db
    .prepare(
      `SELECT holder, started_at, heartbeat_at
       FROM consolidation_lock WHERE id = 1`,
    )
    .get()) as LeaseRow | undefined;
  if (!existing) return false;

  if (existing.holder === holder) {
    const refreshed = await db
      .prepare(
        `UPDATE consolidation_lock SET heartbeat_at = ?
         WHERE id = 1 AND holder = ?`,
      )
      .run(now, holder);
    return refreshed.changes > 0;
  }

  const stamp = leaseAt(existing);
  const elapsed = Date.parse(now) - Date.parse(stamp);
  if (!(elapsed > STALE_LOCK_MS)) return false;

  // Optimistic compare-and-swap: the row we read is still the row we take.
  const taken = await db
    .prepare(
      `UPDATE consolidation_lock
         SET holder = ?, started_at = ?, heartbeat_at = ?
       WHERE id = 1
         AND holder = ?
         AND COALESCE(heartbeat_at, started_at) = ?`,
    )
    .run(holder, now, now, existing.holder, stamp);
  return taken.changes > 0;
}

/** Try to acquire the lock. Returns true if this holder owns the lease. */
export async function acquireLock(db: Db, holder: string): Promise<boolean> {
  const advisory = await holdAdvisory(db, holder);
  if (advisory === "busy") return false;
  try {
    const ok = await withTransaction(db, () => writeLease(db, holder));
    if (!ok && advisory === "acquired") await releaseAdvisory(db, holder);
    return ok;
  } catch (err) {
    if (advisory === "acquired") await releaseAdvisory(db, holder);
    throw err;
  }
}

/**
 * Release the lease if we still hold it, stop the heartbeat, and drop
 * the advisory connection. A holder mismatch deletes nothing — a run
 * that already lost the row must not remove the new holder's lease.
 */
export async function releaseLock(db: Db, holder: string): Promise<boolean> {
  stopBeat(db, holder);
  try {
    const result = await db
      .prepare(`DELETE FROM consolidation_lock WHERE id = 1 AND holder = ?`)
      .run(holder);
    return result.changes > 0;
  } finally {
    await releaseAdvisory(db, holder);
  }
}

/** Check if a lock exists and return its state. */
export async function getLockState(db: Db): Promise<LockState | null> {
  const row = (await db
    .prepare(
      `SELECT holder, started_at, heartbeat_at
       FROM consolidation_lock WHERE id = 1`,
    )
    .get()) as LockState | undefined;
  return row ?? null;
}
