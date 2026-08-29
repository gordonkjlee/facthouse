import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema, getSchemaVersion, SCHEMA_VERSION } = await import(
  "../../src/db/schema.js"
);
const { insertIntelligenceRun, listIntelligenceRuns } = await import(
  "../../src/db/intelligence-runs.js"
);
const { getStats } = await import("../../src/db/stats.js");
const { INTELLIGENCE_STATS_LAST_N } = await import("../../src/intelligence/usage.js");

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

const extractUsage = {
  calls: 1,
  elapsed_ms: 40,
  input_tokens: 100,
  output_tokens: 12,
  stages: {
    extract: {
      provider: "cli" as const,
      model: "haiku",
      calls: 1,
      elapsed_ms: 40,
      input_tokens: 100,
      output_tokens: 12,
    },
  },
};

describe("intelligence_runs", () => {
  it("migrates to the current schema and creates the table", async () => {
    expect(await getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    await insertIntelligenceRun(db, { kind: "consolidate", usage: extractUsage });
    expect(await listIntelligenceRuns(db)).toHaveLength(1);
  });

  it("accepts kind capture without a consolidations row", async () => {
    const id = await insertIntelligenceRun(db, {
      kind: "capture",
      usage: {
        calls: 1,
        elapsed_ms: 15,
        stages: {
          classify: {
            provider: "cli",
            model: "haiku",
            calls: 1,
            elapsed_ms: 15,
            input_tokens: 40,
            output_tokens: 6,
          },
        },
      },
    });
    const rows = await listIntelligenceRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].kind).toBe("capture");
    expect(rows[0].consolidation_id).toBeNull();
    expect(rows[0].usage.stages.classify.model).toBe("haiku");
  });

  it("omits token keys on a blob that never had them", async () => {
    await insertIntelligenceRun(db, {
      kind: "consolidate",
      usage: {
        calls: 2,
        elapsed_ms: 90,
        stages: {
          extract: { provider: "cli", model: "haiku", calls: 2, elapsed_ms: 90 },
        },
      },
    });
    const usage = (await listIntelligenceRuns(db))[0].usage;
    expect(usage.calls).toBe(2);
    expect(usage).not.toHaveProperty("input_tokens");
    expect(usage.stages.extract).not.toHaveProperty("input_tokens");
  });
});

describe("getStats intelligence", () => {
  it("reports zeros on an empty store rather than omitting the field", async () => {
    const s = await getStats(db);
    expect(s.intelligence.last_24h.calls).toBe(0);
    expect(s.intelligence.all_time.calls).toBe(0);
    expect(s.intelligence.recent).toEqual([]);
    expect(s.intelligence.last_24h).not.toHaveProperty("input_tokens");
  });

  it("rolls up last 24h, all-time, and last N including mixed kinds", async () => {
    const now = Date.now();
    await insertIntelligenceRun(db, {
      kind: "consolidate",
      usage: extractUsage,
      createdAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
    });
    await insertIntelligenceRun(db, {
      kind: "consolidate",
      usage: extractUsage,
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
    });
    await insertIntelligenceRun(db, {
      kind: "capture",
      usage: {
        calls: 1,
        elapsed_ms: 20,
        input_tokens: 30,
        output_tokens: 4,
        stages: {
          classify: {
            provider: "cli",
            model: "haiku",
            calls: 1,
            elapsed_ms: 20,
            input_tokens: 30,
            output_tokens: 4,
          },
        },
      },
      createdAt: new Date(now).toISOString(),
    });

    const s = await getStats(db);
    expect(s.intelligence.all_time.calls).toBe(3);
    expect(s.intelligence.last_24h.calls).toBe(2);
    expect(s.intelligence.last_24h.by_stage.extract.calls).toBe(1);
    expect(s.intelligence.last_24h.by_stage.classify.calls).toBe(1);
    expect(s.intelligence.all_time.by_provider.cli.calls).toBe(3);
    expect(s.intelligence.recent[0].kind).toBe("capture");
    expect(s.intelligence.recent[0].stages.classify.provider).toBe("cli");
    expect(s.intelligence.recent[0].stages.classify.model).toBe("haiku");
  });

  it("caps recent at the exported last-N constant", async () => {
    for (let i = 0; i < INTELLIGENCE_STATS_LAST_N + 3; i++) {
      await insertIntelligenceRun(db, {
        kind: "consolidate",
        usage: extractUsage,
        createdAt: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    const s = await getStats(db);
    expect(s.intelligence.recent).toHaveLength(INTELLIGENCE_STATS_LAST_N);
    expect(s.intelligence.all_time.calls).toBe(INTELLIGENCE_STATS_LAST_N + 3);
  });
});
