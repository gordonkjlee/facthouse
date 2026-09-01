/**
 * Consolidation scheduler.
 *
 * The scheduler is purely the coordinating layer around consolidate() — it
 * owns the threshold check, the in-flight guard, and exposes tick()/flush()/full()
 * for callers to invoke when they receive a wake-up signal.
 * tick = D→I, flush = I→K, full = both.
 *
 * Wake-up mechanisms live outside:
 *   - IPC signal from the log-event CLI (src/ipc/scheduler-ipc.ts)
 *   - Lifecycle hooks in src/index.ts (session_start, shutdown)
 *   - Manual calls via the `consolidate` MCP tool
 *
 * This module intentionally knows nothing about sockets, pipes, or fs events.
 */

import { pragmaRead } from "./db/connection.js";
import type { Db } from "./db/connection.js";
import { unexaminedEventCount } from "./db/extract-watermarks.js";
import type {
  ConsolidationResult,
  ConsolidatePhase,
} from "./intelligence/consolidate.js";

export interface SchedulerOpts {
  db: Db;
  /** Called when the scheduler decides to fire a consolidation run. */
  runConsolidate: (phase: ConsolidatePhase) => Promise<ConsolidationResult>;
  /** Events-since-last-consolidation at which tick() fires. */
  threshold: number;
  /** Minimum ms between tick()-driven consolidations. Protects LLM rate
   *  limits during event bursts. flush() bypasses this throttle.
   *  Default 120_000 (2 minutes). */
  minIntervalMs?: number;
}

export interface Scheduler {
  /** D→I when the event threshold is due. After pull. */
  tick(): Promise<ConsolidationResult | null>;
  /** I→K regardless of threshold. PreCompact / shutdown — skip extract. */
  flush(): Promise<ConsolidationResult | null>;
  /** D→I then I→K, forced. Session-start leftovers under the pull cap. */
  full(): Promise<ConsolidationResult | null>;
  /** Release any internal resources. Idempotent. */
  stop(): void;
}

async function readDataVersion(db: Db): Promise<number> {
  const v = await pragmaRead(db, "data_version");
  return typeof v === "number" ? v : 0;
}

async function eventsSinceLastConsolidation(db: Db): Promise<number> {
  return unexaminedEventCount(db);
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
  // consolidations. Assigned before the first await so two ticks in one
  // turn cannot both pass the check. The DB advisory lock is the
  // authoritative guard; this just avoids the wasted call.
  let inFlight: Promise<ConsolidationResult | null> | null = null;

  function runIfDue(
    force: boolean,
    phase: ConsolidatePhase,
  ): Promise<ConsolidationResult | null> {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        if (!force) {
          // Throttle: non-force ticks respect minIntervalMs to protect LLM
          // providers from rate-limit blowups during event bursts.
          if (Date.now() - lastRunAt < minIntervalMs) return null;

          try {
            const current = await readDataVersion(opts.db);
            if (current === lastDataVersion) return null;
            lastDataVersion = current;

            const delta = await eventsSinceLastConsolidation(opts.db);
            if (delta < opts.threshold) return null;
          } catch {
            // Schema not yet applied, DB closed, etc. Skip silently.
            return null;
          }
        }

        try {
          return await opts.runConsolidate(phase);
        } catch {
          // The scheduler must not crash the server. Failure is observable
          // via the consolidations table (no new row written).
          return null;
        } finally {
          lastRunAt = Date.now();
          try {
            lastDataVersion = await readDataVersion(opts.db);
          } catch {
            /* ignore */
          }
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    tick: () => runIfDue(false, "extract"),
    flush: () => runIfDue(true, "graduate"),
    full: () => runIfDue(true, "full"),
    stop: () => {
      // Nothing to release now that the scheduler holds no timers or watchers.
    },
  };
}
