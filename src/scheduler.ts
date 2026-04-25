/**
 * Consolidation scheduler.
 *
 * The scheduler is purely the coordinating layer around consolidate() — it
 * owns the threshold check, the in-flight guard, and exposes tick()/flush()
 * for callers to invoke when they receive a wake-up signal.
 *
 * Wake-up mechanisms live outside:
 *   - IPC signal from the log-event CLI (src/ipc/scheduler-ipc.ts)
 *   - Lifecycle hooks in src/index.ts (session_start, shutdown)
 *   - Manual calls via the `consolidate` MCP tool
 *
 * This module intentionally knows nothing about sockets, pipes, or fs events.
 */

import type Database from "better-sqlite3";
import type { ConsolidationResult } from "./intelligence/consolidate.js";

export interface SchedulerOpts {
  db: Database.Database;
  /** Called when the scheduler decides to fire a consolidation run. */
  runConsolidate: () => Promise<ConsolidationResult>;
  /** Events-since-last-consolidation at which tick() fires. */
  threshold: number;
  /** Minimum ms between tick()-driven consolidations. Protects LLM rate
   *  limits during event bursts. flush() bypasses this throttle.
   *  Default 120_000 (2 minutes). */
  minIntervalMs?: number;
}

export interface Scheduler {
  /** Check the threshold and fire if due. Used by IPC and opportunistic callers. */
  tick(): Promise<ConsolidationResult | null>;
  /** Force consolidation regardless of the threshold. Used for session_start, shutdown, compaction. */
  flush(): Promise<ConsolidationResult | null>;
  /** Release any internal resources. Idempotent. */
  stop(): void;
}

function readDataVersion(db: Database.Database): number {
  const v = db.pragma("data_version", { simple: true });
  return typeof v === "number" ? v : 0;
}

function eventsSinceLastConsolidation(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) AS seq FROM session_events`)
    .get() as { seq: number };
  const last = db
    .prepare(
      `SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`,
    )
    .get() as { seq: number };
  return row.seq - last.seq;
}

export function startScheduler(opts: SchedulerOpts): Scheduler {
  const minIntervalMs = opts.minIntervalMs ?? 120_000;

  // Last data_version we observed. When unchanged, the DB hasn't been
  // committed to by another connection since the last run — skip the SQL
  // count. Initialised to NaN so the first tick always does a full check.
  let lastDataVersion = Number.NaN;

  // Timestamp of last completed consolidation. Used by the minIntervalMs
  // throttle to prevent tick-driven runs from firing too often.
  let lastRunAt = 0;

  // Serialises scheduler runs so overlapping signals don't start parallel
  // consolidations. The DB advisory lock is the authoritative guard; this
  // just avoids the wasted call.
  let inFlight: Promise<ConsolidationResult | null> | null = null;

  async function runIfDue(force: boolean): Promise<ConsolidationResult | null> {
    if (inFlight) return inFlight;

    if (!force) {
      // Throttle: non-force ticks respect minIntervalMs to protect LLM
      // providers from rate-limit blowups during event bursts.
      if (Date.now() - lastRunAt < minIntervalMs) return null;

      try {
        const current = readDataVersion(opts.db);
        if (current === lastDataVersion) return null;
        lastDataVersion = current;

        const delta = eventsSinceLastConsolidation(opts.db);
        if (delta < opts.threshold) return null;
      } catch {
        // Schema not yet applied, DB closed, etc. Skip silently.
        return null;
      }
    }

    inFlight = (async () => {
      try {
        return await opts.runConsolidate();
      } catch {
        // The scheduler must not crash the server. Failure is observable
        // via the consolidations table (no new row written).
        return null;
      } finally {
        inFlight = null;
        lastRunAt = Date.now();
        try {
          lastDataVersion = readDataVersion(opts.db);
        } catch {
          /* ignore */
        }
      }
    })();
    return inFlight;
  }

  return {
    tick: () => runIfDue(false),
    flush: () => runIfDue(true),
    stop: () => {
      // Nothing to release now that the scheduler holds no timers or watchers.
    },
  };
}
