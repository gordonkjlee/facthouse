/**
 * The vocabulary table. Copy, extract, integrate; consolidate; moments.
 * One definition, so these tests pin the public meaning of each flag and
 * each moment rather than re-deriving it in three places.
 */

import { describe, it, expect } from "vitest";
import {
  ALL_STEPS,
  EXTRACT_CAP_EVENTS,
  MOMENTS,
  MOMENT_POLICY,
  NOTIFIABLE_MOMENTS,
  isMoment,
  isNotifiableMoment,
  stepsFromFlags,
} from "../../src/intelligence/steps.js";

describe("stepsFromFlags", () => {
  it("no flags means every step", () => {
    expect(stepsFromFlags({})).toEqual({ copy: true, extract: true, integrate: true });
    expect(stepsFromFlags({ copy: false, extract: false, integrate: false })).toEqual(
      ALL_STEPS,
    );
  });

  it("named steps run and unnamed steps are skipped", () => {
    expect(stepsFromFlags({ copy: true })).toEqual({
      copy: true,
      extract: false,
      integrate: false,
    });
    expect(stepsFromFlags({ integrate: true })).toEqual({
      copy: false,
      extract: false,
      integrate: true,
    });
    expect(stepsFromFlags({ copy: true, extract: true })).toEqual({
      copy: true,
      extract: true,
      integrate: false,
    });
  });

  it("returns a fresh object, never the frozen ALL_STEPS", () => {
    const steps = stepsFromFlags({});
    expect(steps).not.toBe(ALL_STEPS);
    steps.copy = false;
    expect(ALL_STEPS.copy).toBe(true);
  });
});

describe("moments", () => {
  it("are the consolidation.triggers vocabulary", () => {
    expect([...MOMENTS]).toEqual([
      "session_start",
      "threshold",
      "compaction",
      "shutdown",
      "manual",
    ]);
    for (const m of MOMENTS) expect(isMoment(m)).toBe(true);
    expect(isMoment("tick")).toBe(false);
    expect(isMoment("flush")).toBe(false);
  });

  it("only threshold and compaction can be sent from another process", () => {
    expect([...NOTIFIABLE_MOMENTS]).toEqual(["threshold", "compaction"]);
    expect(isNotifiableMoment("compaction")).toBe(true);
    expect(isNotifiableMoment("shutdown")).toBe(false);
    expect(isNotifiableMoment("manual")).toBe(false);
  });

  it("threshold is the only gated moment and the only extract-only one", () => {
    expect(MOMENT_POLICY.threshold).toEqual({
      steps: { copy: false, extract: true, integrate: false },
      force: false,
    });
    for (const m of MOMENTS) {
      if (m === "threshold") continue;
      expect(MOMENT_POLICY[m].force).toBe(true);
    }
  });

  it("compaction runs everything; shutdown integrates only", () => {
    expect(MOMENT_POLICY.compaction.steps).toEqual(ALL_STEPS);
    expect(MOMENT_POLICY.session_start.steps).toEqual(ALL_STEPS);
    expect(MOMENT_POLICY.manual.steps).toEqual(ALL_STEPS);
    expect(MOMENT_POLICY.shutdown.steps).toEqual({
      copy: false,
      extract: false,
      integrate: true,
    });
  });

  it("the extract cap is the documented 50 events", () => {
    expect(EXTRACT_CAP_EVENTS).toBe(50);
  });
});
