/**
 * The pipeline vocabulary, in one place.
 *
 * Layers: D (session_events) → I (session_facts, pending) → K (facts).
 * Steps:  copy (sources → D), extract (D → I), integrate (I → K).
 * Umbrella: consolidate = copy + extract + integrate.
 *
 * Moments are when the server runs consolidate on its own: the values of
 * `consolidation.triggers` in config.json. Each moment maps to the steps it
 * runs and whether it bypasses the threshold / throttle gate. The `notify`
 * CLI verb and the IPC byte carry a moment, never a step, so the policy
 * below is the only place the mapping lives.
 */

export interface ConsolidateSteps {
  copy: boolean;
  extract: boolean;
  integrate: boolean;
}

export const ALL_STEPS: ConsolidateSteps = Object.freeze({
  copy: true,
  extract: true,
  integrate: true,
});

/**
 * Build the step set from CLI flags. Named steps run, in pipeline order,
 * over whatever is already there; unnamed steps are skipped; none named
 * means all three.
 */
export function stepsFromFlags(flags: {
  copy?: boolean;
  extract?: boolean;
  integrate?: boolean;
}): ConsolidateSteps {
  const any = Boolean(flags.copy || flags.extract || flags.integrate);
  if (!any) return { ...ALL_STEPS };
  return {
    copy: Boolean(flags.copy),
    extract: Boolean(flags.extract),
    integrate: Boolean(flags.integrate),
  };
}

/**
 * Extract is the only step whose cost scales with the backlog: one model
 * call per conversation chunk. Every run extracts at most this many of the
 * oldest unexamined events unless told otherwise (`--all`, `--limit N`), so a
 * first backfill of a whole client home never spawns the model on the lot,
 * and an automatic run never blocks — it always makes bounded progress.
 */
export const EXTRACT_CAP_EVENTS = 50;

export type Moment =
  | "session_start"
  | "threshold"
  | "compaction"
  | "shutdown"
  | "manual";

export const MOMENTS: readonly Moment[] = Object.freeze([
  "session_start",
  "threshold",
  "compaction",
  "shutdown",
  "manual",
]);

export function isMoment(value: string): value is Moment {
  return (MOMENTS as readonly string[]).includes(value);
}

export interface MomentPolicy {
  steps: ConsolidateSteps;
  /** Bypass the threshold check and the rate throttle. */
  force: boolean;
}

/**
 * What the server does at each moment.
 *
 * threshold     — events arrived (record, or a client nudge). Extract if
 *                 the unexamined count is due and the throttle allows. No
 *                 copy: a record store has no sources, and a copy store's
 *                 heartbeat already copied before the call that raised the
 *                 count.
 * compaction    — the client's window is about to collapse. Everything, now,
 *                 asynchronously: copy the last lines, extract, integrate.
 * session_start — leftovers from a previous process. Everything.
 * shutdown      — no time for a model pass over D. Integrate what is pending.
 * manual        — the MCP tool. Everything.
 */
export const MOMENT_POLICY: Readonly<Record<Moment, MomentPolicy>> = Object.freeze({
  session_start: { steps: { ...ALL_STEPS }, force: true },
  threshold: {
    steps: { copy: false, extract: true, integrate: false },
    force: false,
  },
  compaction: { steps: { ...ALL_STEPS }, force: true },
  shutdown: {
    steps: { copy: false, extract: false, integrate: true },
    force: true,
  },
  manual: { steps: { ...ALL_STEPS }, force: true },
});

/** Moments a separate process may send to the running server. */
export type NotifiableMoment = "threshold" | "compaction";

export const NOTIFIABLE_MOMENTS: readonly NotifiableMoment[] = Object.freeze([
  "threshold",
  "compaction",
]);

export function isNotifiableMoment(value: string): value is NotifiableMoment {
  return (NOTIFIABLE_MOMENTS as readonly string[]).includes(value);
}
