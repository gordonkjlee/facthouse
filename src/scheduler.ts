/**
 * Consolidation scheduler.
 *
 * The scheduler is purely the coordinating layer around consolidate() — it
 * owns the threshold check, the throttle, and the in-flight guard, and
 * exposes run(moment) for callers that receive a wake-up.
 *
 * Which steps a moment runs, and whether it bypasses the gate, is the
 * MOMENT_POLICY table in src/intelligence/steps.ts — one definition.
 *
 * Wake-up mechanisms live outside:
 *   - IPC moment from another process (src/ipc/scheduler-ipc.ts)
 *   - Lifecycle hooks in src/index.ts (session_start, shutdown)
 *   - Manual calls via the `consolidate` MCP tool
 *
 * This module intentionally knows nothing about sockets, pipes, or fs events.
 */

import { pragmaRead } from "./db/connection.js";
import type { Db } from "./db/connection.js";
import { unexaminedEventCount } from "./db/extract-watermarks.js";
import type { ConsolidationResult } from "./intelligence/consolidate.js";
import {
  MOMENT_POLICY,
  type ConsolidateSteps,
  type Moment,
} from "./intelligence/steps.js";

export interface SchedulerOpts {
  db: Db;
  /** Called when the scheduler decides to fire a consolidation run. */
  runConsolidate: (
    steps: ConsolidateSteps,
    moment: Moment,
  ) => Promise<ConsolidationResult>;
  /** Unexamined events at which a non-forced moment fires. */
  threshold: number;
  /** Minimum ms between non-forced runs. Protects LLM rate limits during
   *  event bursts. Forced moments bypass this throttle.
   *  Default 120_000 (2 minutes). */
  minIntervalMs?: number;
}

export interface Scheduler {
  /** Run the steps MOMENT_POLICY assigns to this moment. */
  run(moment: Moment): Promise<ConsolidationResult | null>;
  /** Release any internal resources. Idempotent. */
  stop(): void;
}

async function readDataVersion(db: Db): Promise<number> {
  const v = await pragmaRead(db, "data_version");
  return typeof v === "number" ? v : 0;
}

export function startScheduler(opts: SchedulerOpts): Scheduler {
  const minIntervalMs = opts.minIntervalMs ?? 120_000;

  // Last data_version we observed. When unchanged, the DB hasn't been
  // committed to by another connection since the last run — skip the SQL
  // count. Initialised to NaN so the first run always does a full check.
  let lastDataVersion = Number.NaN;

  // Timestamp of last completed consolidation. Used by the minIntervalMs
  // throttle to prevent threshold-driven runs from firing too often.
  let lastRunAt = 0;

  // Serialises scheduler runs so overlapping moments don't start parallel
  // consolidations. Assigned before the first await so two moments in one
  // turn cannot both pass the check. The DB advisory lock is the
  // authoritative guard; this just avoids the wasted call.
  let inFlight: Promise<ConsolidationResult | null> | null = null;

  function run(moment: Moment): Promise<ConsolidationResult | null> {
    if (inFlight) return inFlight;
    const policy = MOMENT_POLICY[moment];

    inFlight = (async () => {
      try {
        if (!policy.force) {
          if (Date.now() - lastRunAt < minIntervalMs) return null;

          try {
            const current = await readDataVersion(opts.db);
            if (current === lastDataVersion) return null;
            lastDataVersion = current;

            const delta = await unexaminedEventCount(opts.db);
            if (delta < opts.threshold) return null;
          } catch {
            // Schema not yet applied, DB closed, etc. Skip silently.
            return null;
          }
        }

        try {
          return await opts.runConsolidate({ ...policy.steps }, moment);
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
    run,
    stop: () => {
      // Nothing to release now that the scheduler holds no timers or watchers.
    },
  };
}
