import { describe, it, expect } from "vitest";
import {
  INTELLIGENCE_STATS_LAST_N,
  UsageAccumulator,
  addOptional,
  canonicalStage,
  parseEnvelopeUsage,
  parseStoredUsage,
  rollupRuns,
  type StoredIntelligenceRun,
} from "../../src/intelligence/usage.js";

describe("canonicalStage", () => {
  it("maps CLI stage names to the public stage list", () => {
    expect(canonicalStage("stage-1-extract")).toBe("extract");
    expect(canonicalStage("stage-2-reconcile")).toBe("reconcile");
    expect(canonicalStage("stage-3-supersede")).toBe("supersede");
    expect(canonicalStage("stage-4-summarise")).toBe("summarise");
    expect(canonicalStage("stage-classify")).toBe("classify");
    expect(canonicalStage("stage-entities")).toBe("entities");
  });
});

describe("parseEnvelopeUsage", () => {
  it("maps input and output tokens and discards USD", () => {
    const parsed = parseEnvelopeUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_cost_usd: 0.42,
      },
    });
    expect(parsed).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(parsed).not.toHaveProperty("total_cost_usd");
  });

  it("folds cache-creation and cache-read into input", () => {
    const parsed = parseEnvelopeUsage({
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 3,
        output_tokens: 2,
      },
    });
    expect(parsed.input_tokens).toBe(18);
    expect(parsed.output_tokens).toBe(2);
  });

  it("omits token keys when usage is missing, rather than storing zero", () => {
    expect(parseEnvelopeUsage({ result: "ok" })).toEqual({});
    expect(parseEnvelopeUsage({ usage: {} })).toEqual({});
    expect(parseEnvelopeUsage(null)).toEqual({});
  });
});

describe("UsageAccumulator", () => {
  it("sums calls and tokens per stage and keeps provider plus model", () => {
    const acc = new UsageAccumulator({ provider: "cli", model: "haiku" });
    acc.record("stage-1-extract", {
      input_tokens: 100,
      output_tokens: 10,
      elapsed_ms: 50,
    });
    acc.record("stage-1-extract", {
      input_tokens: 80,
      output_tokens: 8,
      elapsed_ms: 40,
    });
    const snap = acc.snapshot();
    expect(snap.calls).toBe(2);
    expect(snap.input_tokens).toBe(180);
    expect(snap.output_tokens).toBe(18);
    expect(snap.elapsed_ms).toBe(90);
    expect(snap.stages.extract).toEqual({
      provider: "cli",
      model: "haiku",
      calls: 2,
      input_tokens: 180,
      output_tokens: 18,
      elapsed_ms: 90,
    });
  });

  it("leaves token keys absent when the provider did not report them", () => {
    const acc = new UsageAccumulator({ provider: "cli", model: "haiku" });
    acc.record("stage-classify", { elapsed_ms: 12 });
    const snap = acc.snapshot();
    expect(snap.calls).toBe(1);
    expect(snap).not.toHaveProperty("input_tokens");
    expect(snap).not.toHaveProperty("output_tokens");
    expect(snap.stages.classify).not.toHaveProperty("input_tokens");
  });

  it("take() drains so a later run does not inherit the previous bill", () => {
    const acc = new UsageAccumulator({ provider: "cli", model: "haiku" });
    acc.record("extract", { input_tokens: 1, elapsed_ms: 1 });
    const first = acc.take();
    expect(first?.calls).toBe(1);
    expect(acc.take()).toBeNull();
  });
});

describe("addOptional", () => {
  it("stays absent when both sides are absent", () => {
    expect(addOptional(undefined, undefined)).toBeUndefined();
    expect(addOptional(4, undefined)).toBe(4);
    expect(addOptional(undefined, 3)).toBe(3);
  });
});

describe("rollupRuns", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  function run(
    over: Partial<StoredIntelligenceRun> & { id: string; created_at: string },
  ): StoredIntelligenceRun {
    return {
      kind: "consolidate",
      consolidation_id: null,
      usage: {
        calls: 1,
        elapsed_ms: 10,
        input_tokens: 5,
        output_tokens: 1,
        stages: {
          extract: {
            provider: "cli",
            model: "haiku",
            calls: 1,
            elapsed_ms: 10,
            input_tokens: 5,
            output_tokens: 1,
          },
        },
      },
      ...over,
    };
  }

  it("splits last 24h from all-time and keeps last N newest first", () => {
    const runs = [
      run({ id: "old", created_at: "2026-08-26T12:00:00.000Z" }),
      run({ id: "mid", created_at: "2026-08-28T01:00:00.000Z" }),
      run({
        id: "cap",
        kind: "capture",
        created_at: "2026-08-28T11:00:00.000Z",
        usage: {
          calls: 2,
          elapsed_ms: 20,
          stages: {
            classify: {
              provider: "cli",
              model: "haiku",
              calls: 1,
              elapsed_ms: 10,
            },
            entities: {
              provider: "cli",
              model: "haiku",
              calls: 1,
              elapsed_ms: 10,
            },
          },
        },
      }),
    ];
    const stats = rollupRuns(runs, now, 2);
    expect(INTELLIGENCE_STATS_LAST_N).toBe(10);
    expect(stats.all_time.calls).toBe(4);
    expect(stats.last_24h.calls).toBe(3);
    expect(stats.recent).toHaveLength(2);
    expect(stats.recent[0].id).toBe("cap");
    expect(stats.recent[0].kind).toBe("capture");
    expect(stats.recent[1].id).toBe("mid");
    expect(stats.all_time.by_provider.cli.calls).toBe(4);
    expect(stats.last_24h.by_stage.classify?.calls).toBe(1);
    expect(stats.last_24h.by_stage.extract?.calls).toBe(1);
  });
});

describe("parseStoredUsage", () => {
  it("rejects malformed blobs rather than inventing zeros", () => {
    expect(parseStoredUsage("not-json")).toBeNull();
    expect(parseStoredUsage("{}")).toBeNull();
  });
});
