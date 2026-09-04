import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { StoredIntelligenceRun } from "../../src/intelligence/usage.js";
import {
  parseTokenCount,
  parseTokenBudget,
  formatTokenCount,
  evaluateTokenBudget,
  verdictForProvider,
  billedProviderName,
  billedCapName,
  forBilledProvider,
  formatResetAt,
  tokenBudgetUsageLead,
  TOKEN_BUDGET_HOW_TO,
  TOKEN_BUDGET_HOW_TO_SET,
  TokenBudgetError,
} from "../../src/intelligence/token-budget.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function run(opts: {
  id?: string;
  createdAt?: string;
  provider?: string;
  tokens?: number;
  unmetered?: boolean;
  trigger?: string;
}): StoredIntelligenceRun {
  const provider = opts.provider ?? "cli";
  const stage = opts.unmetered
    ? { provider, model: "haiku", calls: 1, elapsed_ms: 5 }
    : {
        provider,
        model: "haiku",
        calls: 1,
        elapsed_ms: 5,
        input_tokens: opts.tokens ?? 100,
        output_tokens: 0,
      };
  return {
    id: opts.id ?? "r1",
    kind: "consolidate",
    consolidation_id: null,
    created_at: opts.createdAt ?? NOW.toISOString(),
    usage: {
      calls: 1,
      elapsed_ms: 5,
      stages: { extract: stage },
      ...(opts.unmetered
        ? {}
        : { input_tokens: opts.tokens ?? 100, output_tokens: 0 }),
    },
    trigger: opts.trigger ?? "mcp",
  };
}

describe("parseTokenCount", () => {
  it("parses k M G suffixes", () => {
    expect(parseTokenCount("500k")).toBe(500_000);
    expect(parseTokenCount("10M")).toBe(10_000_000);
    expect(parseTokenCount("1G")).toBe(1_000_000_000);
    expect(parseTokenCount(250)).toBe(250);
  });

  it("rejects disk units rather than treating them as tokens", () => {
    expect(() => parseTokenCount("2GB")).toThrow(TokenBudgetError);
    expect(() => parseTokenCount("2GB")).toThrow(/not disk units/);
    expect(() => parseTokenCount("512MB")).toThrow(TokenBudgetError);
  });
});

describe("parseTokenBudget", () => {
  it("treats omit as unlimited", () => {
    expect(parseTokenBudget(null)).toBeNull();
    expect(parseTokenBudget(undefined)).toBeNull();
    expect(parseTokenBudget("")).toBeNull();
    expect(parseTokenBudget({})).toBeNull();
  });

  it("parses per-provider stacked windows", () => {
    expect(parseTokenBudget({ cli: { hour: "500k", week: "10M" } })).toEqual({
      cli: { hour: 500_000, week: 10_000_000 },
    });
  });

  it("rejects a bare string", () => {
    expect(() => parseTokenBudget("2M")).toThrow(/token_budget/);
    expect(() => parseTokenBudget("2M")).toThrow(/cli/);
  });

  it("rejects disk units on a window value", () => {
    expect(() => parseTokenBudget({ cli: { week: "2GB" } })).toThrow(
      /not disk units/,
    );
  });

  it("ignores http — local intelligence is not billed", () => {
    expect(parseTokenBudget({ http: { week: "10M" } })).toBeNull();
    expect(
      parseTokenBudget({ http: { week: "10M" }, cli: { week: "10M" } }),
    ).toEqual({ cli: { week: 10_000_000 } });
  });

  it("rejects unknown provider keys", () => {
    expect(() => parseTokenBudget({ ollama: { week: "10M" } })).toThrow(
      /token_budget/,
    );
  });
});

describe("provider copy", () => {
  it("says CLI rather than cli", () => {
    expect(billedProviderName("cli")).toBe("CLI");
    expect(forBilledProvider("cli")).toBe("for the CLI");
    expect(forBilledProvider("sampling")).toBe("for sampling");
  });
});

describe("formatTokenCount", () => {
  it("uses the same suffixes the config accepts", () => {
    expect(formatTokenCount(10_000_000)).toBe("10M");
    expect(formatTokenCount(8_000_000)).toBe("8M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
    expect(formatTokenCount(7_976_000)).toBe("7.98M");
    expect(formatTokenCount(500_000)).toBe("500k");
  });

  it("leads with used and remaining, then when the window refills", () => {
    expect(billedCapName("cli", "week")).toBe("CLI weekly cap");
    const reset = "2026-09-05T12:00:00.000Z";
    expect(
      tokenBudgetUsageLead({
        provider: "cli",
        scale: "week",
        used: 2_024_000,
        remaining: 7_976_000,
        cap: 10_000_000,
        resets_at: reset,
        now: NOW,
      }),
    ).toEqual({
      lead: "2.02M used · 7.98M remaining",
      detail: "10M CLI weekly cap · resets 5 Sept",
    });
  });

  it("shows the UTC clock only when reset is within 36 hours", () => {
    const reset = "2026-09-05T12:00:00.000Z";
    expect(formatResetAt(reset, NOW)).toBe("5 Sept");
    expect(formatResetAt(reset, new Date("2026-09-04T09:07:00.000Z"))).toBe(
      "5 Sept, 12:00",
    );
  });
});

describe("evaluateTokenBudget", () => {
  const week100 = parseTokenBudget({ cli: { week: "100" } });

  it("skips when a set window is at cap", () => {
    const report = evaluateTokenBudget(
      [run({ tokens: 100 })],
      week100,
      NOW,
    );
    const verdict = verdictForProvider(report, "cli");
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toMatch(/CLI/);
    expect(verdict.reason).toMatch(/last 7 days/);
    expect(verdict.reason).toMatch(/100/);
    expect(report.providers.cli?.windows[0]?.remaining).toBe(0);
  });

  it("requires every set window to pass", () => {
    const budget = parseTokenBudget({
      cli: { hour: "1000000", week: "100" },
    });
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const report = evaluateTokenBudget(
      [run({ tokens: 100, createdAt: twoHoursAgo })],
      budget,
      NOW,
    );
    expect(verdictForProvider(report, "cli").skip).toBe(true);
  });

  it("leaves unset scales unlimited", () => {
    const report = evaluateTokenBudget(
      [run({ tokens: 1000 })],
      parseTokenBudget({ cli: { week: "10000" } }),
      NOW,
    );
    expect(verdictForProvider(report, "cli").skip).toBe(false);
    expect(report.providers.cli?.windows).toHaveLength(1);
  });

  it("is unlimited when token_budget is unset", () => {
    const report = evaluateTokenBudget([run({ tokens: 9_000_000_000 })], null, NOW);
    expect(verdictForProvider(report, "cli").skip).toBe(false);
    expect(report.how_to).toBe(TOKEN_BUDGET_HOW_TO);
    expect(report.how_to).toContain('"week": "10M"');
  });

  it("fails closed on unmetered billed work in the window", () => {
    const report = evaluateTokenBudget(
      [run({ unmetered: true })],
      week100,
      NOW,
    );
    const verdict = verdictForProvider(report, "cli");
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toMatch(/without reporting tokens/);
    expect(report.providers.cli?.unmetered).toBe(true);
    expect(report.providers.cli?.windows[0]?.used).toBe(0);
  });

  it("does not treat heuristic rows as billed", () => {
    const report = evaluateTokenBudget(
      [run({ unmetered: true, provider: "heuristic" })],
      week100,
      NOW,
    );
    expect(verdictForProvider(report, "cli").skip).toBe(false);
  });

  it("does not add http usage to the cli pot", () => {
    const report = evaluateTokenBudget(
      [
        run({ id: "http", provider: "http", tokens: 10_000 }),
        run({ id: "cli", tokens: 100 }),
      ],
      week100,
      NOW,
    );
    expect(report.providers.cli?.windows[0]?.used).toBe(100);
    expect(verdictForProvider(report, "cli").skip).toBe(true);
    expect(verdictForProvider(report, "http").skip).toBe(false);
  });

  it("drops usage older than the rolling window", () => {
    const eightDaysAgo = new Date(
      NOW.getTime() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const report = evaluateTokenBudget(
      [run({ tokens: 100, createdAt: eightDaysAgo })],
      week100,
      NOW,
    );
    expect(verdictForProvider(report, "cli").skip).toBe(false);
    expect(report.providers.cli?.windows[0]?.used).toBe(0);
  });

  it("sums both agents onto one provider pot", () => {
    const report = evaluateTokenBudget(
      [
        run({ id: "a", tokens: 40, trigger: "mcp" }),
        run({ id: "b", tokens: 60, trigger: "cli" }),
      ],
      week100,
      NOW,
    );
    expect(report.providers.cli?.windows[0]?.used).toBe(100);
    expect(verdictForProvider(report, "cli").skip).toBe(true);
  });

  it("points remaining at the same helper the gate uses", () => {
    const report = evaluateTokenBudget(
      [run({ tokens: 1_000_000 })],
      parseTokenBudget({ cli: { week: "10M" } }),
      NOW,
    );
    expect(report.providers.cli?.windows[0]?.remaining).toBe(9_000_000);
    expect(report.providers.cli?.windows[0]?.resets_at).toBe(
      new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(report.how_to).toBe(TOKEN_BUDGET_HOW_TO_SET);
    expect(report.tightest?.provider).toBe("cli");
    expect(report.tightest?.scale).toBe("week");
  });
});

describe("token-budget module", () => {
  it("does not import parseDiskBudget", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/intelligence/token-budget.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/from ["'][^"']*disk-budget/);
  });
});
