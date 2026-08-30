import { describe, it, expect } from "vitest";
import type { KnowledgeStats } from "../../src/db/stats.js";
import {
  formatStatsHtml,
  renderSpendBoard,
  spendAxisTicks,
  spendBucketLabel,
  SPEND_BOARD_CSS,
} from "../../src/cli/stats-html.js";
import { spendDashboardFromStats } from "../../src/cli/spend-dashboard.js";

function stats(over: Partial<KnowledgeStats> = {}): KnowledgeStats {
  return {
    facts: { active_latest: 0, total: 0 },
    entities: 0,
    domains: 0,
    consolidations: 0,
    domain_distribution: [],
    embeddings: [],
    events: { count: 0, bytes: 0, reclaimable: { events: 0, bytes: 0 } },
    extract: { watermark: 0, unextracted_events: 0 },
    pending_facts: 0,
    intelligence: {
      last_24h: { calls: 0, elapsed_ms: 0, by_stage: {}, by_provider: {} },
      all_time: { calls: 0, elapsed_ms: 0, by_stage: {}, by_provider: {} },
      recent: [],
    },
    ...over,
  };
}

describe("renderSpendBoard", () => {
  it("does not dump knowledge domains or entity types", () => {
    const html = renderSpendBoard(
      stats({
        facts: { active_latest: 1, total: 1 },
        domain_distribution: [{ domain: "warehouse", count: 1 }],
      }),
    );
    expect(html).not.toContain("By domain");
    expect(html).not.toContain("warehouse");
  });

  it("escapes JSON so a fact label cannot break the page", () => {
    const html = renderSpendBoard(
      stats({
        facts: { active_latest: 1, total: 1 },
        domain_distribution: [{ domain: `<img src=x onerror=alert(1)>`, count: 1 }],
      }),
    );
    expect(html).not.toContain("<img src=x");
  });

  it("leads with catch-up and cost, and keeps a cursor tooltip plus more-detail", () => {
    const dash = spendDashboardFromStats(
      stats({
        extract: { watermark: 10, unextracted_events: 7110 },
        pending_facts: 2,
        intelligence: {
          last_24h: {
            calls: 73,
            elapsed_ms: 90_000,
            input_tokens: 924_000,
            output_tokens: 15_900,
            by_stage: {},
            by_provider: {},
          },
          all_time: {
            calls: 73,
            elapsed_ms: 90_000,
            input_tokens: 924_000,
            output_tokens: 15_900,
            by_stage: {},
            by_provider: {},
          },
          recent: [
            {
              id: "r1",
              kind: "consolidate",
              created_at: "2026-08-28T10:18:47.756Z",
              consolidation_id: "c1",
              calls: 73,
              elapsed_ms: 90_000,
              input_tokens: 924_000,
              output_tokens: 15_900,
              stages: {
                extract: {
                  provider: "cli",
                  model: "haiku",
                  calls: 4,
                  elapsed_ms: 10,
                  input_tokens: 360_000,
                  output_tokens: 3_200,
                },
                reconcile: {
                  provider: "cli",
                  model: "haiku",
                  calls: 34,
                  elapsed_ms: 40,
                  input_tokens: 272_000,
                  output_tokens: 6_800,
                },
              },
            },
          ],
        },
      }),
    );
    dash.days = [
      {
        day: "2026-08-28",
        logged: 160,
        examined: 40,
        unread: 120,
        staged: 34,
        graduated: 32,
        calls: 73,
        input_tokens: 924_000,
        output_tokens: 15_900,
      },
    ];
    const html = renderSpendBoard(dash);
    expect(html).toContain("Catch-up");
    expect(html).toContain("7,110 chat lines still waiting");
    expect(html).toContain("Cost");
    expect(html).toContain("om-chart");
    expect(html).toContain("om-tip");
    expect(html).toContain("More detail");
    expect(html).toContain('class="grow cost-only" id="om-detail"');
    expect(html).toContain("data-mode=\"catchup\"");
    expect(html).toContain("data-mode=\"cost\"");
    expect(html).toContain('data-grain="day"');
    expect(html).toContain('data-grain="week"');
    expect(html).toContain('data-grain="month"');
    expect(html).toContain("12 months");
    expect(html).toContain("26 weeks");
    expect(html).toContain("14 days");
    expect(html).toContain("Turns new conversation lines");
    expect(html).toContain("Matching memory");
    expect(html).toContain("spend-detail-only");
    expect(html).not.toContain("Unextracted events");
    expect(html).not.toContain("Pending I");
    expect(html).not.toContain("Hover a stage to see");
    expect(html).toContain("uses in the last 24 hours");
    expect(html).toContain("Embeddings are not counted");
    expect(html).not.toContain("Tokens are the bill");
    expect(html).toContain('"hasTokens":true');
    expect(html).toContain('metric = D.hasTokens ? "tokens" : "calls"');
    expect(html).toContain('id="om-catch-metric"');
    expect(html).toContain('data-cmetric="waiting"');
    expect(html).toContain('class="spend-seg catch-only" id="om-catch-metric"');
    expect(html).toContain("spend-split");
    expect(html).toContain("spend-cluster");
    expect(html).toContain('class="spend-seg cost-only spend-detail-only" id="om-metrics"');
    expect(html).toContain('class="spend-seg cost-only spend-detail-only" id="om-filter"');
    expect(html).toContain('classList.toggle("is-cost"');
    expect(html).toContain("function spendAxisTicks");
    expect(html).toContain("writeDay");
    expect(html).not.toContain("story.textContent");
    expect(html).not.toContain("still waiting to become memory");
    expect(html).toContain("id=\"om-stage-bars\"");
    expect(html).toContain("Each model run in this bar");
    expect(html).toContain("function spendBucketKey");
    expect(html).toContain("function rollSpendDays");
    expect(html).toContain("token_budget");
    expect(html).toContain("10M");
    expect(html).toContain("config.json");
    expect(html).not.toContain("spend-caps");
    expect(html).toContain('data-mode="catchup" class="on"');
  });

  it("leads Cost with remaining room and the set-cap how-to", () => {
    const html = renderSpendBoard(
      stats({
        facts: { active_latest: 1, total: 1 },
        token_budget: {
          how_to: "Edit token_budget in this store's config.json.",
          tightest: {
            provider: "cli",
            scale: "week",
            used: 2_000_000,
            cap: 10_000_000,
            remaining: 8_000_000,
          },
          providers: {
            cli: {
              unmetered: false,
              windows: [
                {
                  scale: "week",
                  used: 2_000_000,
                  cap: 10_000_000,
                  remaining: 8_000_000,
                },
              ],
            },
          },
        },
      }),
    );
    expect(html).toContain("8M remaining of 10M on the CLI 7-day cap");
    expect(html).toContain("last 7 days count toward this cap");
    expect(html).not.toContain("cli week");
    expect(html).not.toContain("left for the CLI in the last 7 days");
    expect(html).toContain("Edit token_budget");
    expect(html).toContain("config.json");
    expect(html).toContain("spend-caps");
    expect(html).toContain("CLI 7-day cap");
    expect(html).toContain("2M of 10M");
    expect(html).toContain("width:20.0%");
    expect(html).not.toContain("uses in the last 24 hours");
    expect(html).toContain("is-cost");
    expect(html).toContain("Tokens the model read");
    expect(html).toContain('data-mode="cost" class="on"');
  });

  it("warns when the cap is spent and says extract is paused", () => {
    const html = renderSpendBoard(
      stats({
        facts: { active_latest: 1, total: 1 },
        token_budget: {
          how_to: "Edit token_budget in this store's config.json.",
          tightest: {
            provider: "cli",
            scale: "week",
            used: 10_000_000,
            cap: 10_000_000,
            remaining: 0,
          },
          providers: {
            cli: {
              unmetered: false,
              windows: [
                {
                  scale: "week",
                  used: 10_000_000,
                  cap: 10_000_000,
                  remaining: 0,
                },
              ],
            },
          },
        },
      }),
    );
    expect(html).toContain("The CLI 7-day cap is spent");
    expect(html).toContain("Billed extract is paused");
    expect(html).toContain("spend-hero-card warn");
    expect(html).toContain("is-full");
    expect(html).toContain("width:100.0%");
  });

  it("plots an empty chart against 0, not 1", () => {
    const html = renderSpendBoard(stats());
    expect(html).toContain("var max = 0");
    expect(html).toContain("if (max <= 0)");
  });

  it("names who invoked each run in More detail", () => {
    const html = renderSpendBoard(stats());
    expect(html).toContain("<th>Who</th>");
    expect(html).toContain("whoRan(r.trigger)");
  });

  it("fills stage bars as a block so width is the share of that day's metric", () => {
    expect(SPEND_BOARD_CSS).toContain(".spend-stage .fill { display: block");
    expect(SPEND_BOARD_CSS).toContain(".spend-cap .fill { display: block");
    expect(SPEND_BOARD_CSS).toContain("width: 0");
    expect(SPEND_BOARD_CSS).toContain(".spend-board:not(.is-cost) #om-detail");
    expect(SPEND_BOARD_CSS).toContain(".spend-split");
    expect(SPEND_BOARD_CSS).toContain(".spend-board:not(.is-detail) .spend-detail-only");
  });

  it("labels a month of days with numbers every fifth day and month names on boundaries", () => {
    const days = [];
    const start = new Date("2026-07-30T00:00:00.000Z");
    for (let i = 0; i < 30; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      days.push({ day: d.toISOString().slice(0, 10) });
    }
    expect(days[0].day).toBe("2026-07-30");
    expect(days[29].day).toBe("2026-08-28");
    const labelled = days.map((_, i) => spendAxisTicks(i, days));
    expect(labelled[0]).toEqual({ day: "30", month: "Jul" });
    expect(labelled[1]).toEqual({ day: "", month: "" });
    expect(labelled[2]).toEqual({ day: "", month: "Aug" });
    expect(labelled[5]).toEqual({ day: "4", month: "" });
    expect(labelled[29]).toEqual({ day: "28", month: "" });
    const dayLabels = labelled.filter((t) => t.day).length;
    expect(dayLabels).toBeLessThanOrEqual(8);
    const week = days.slice(-7).map((_, i) => spendAxisTicks(i, days.slice(-7)));
    expect(week[0].day).toMatch(/Aug$/);
    expect(week.every((t) => t.day && !t.month)).toBe(true);
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(2025, 8, 1));
      d.setUTCMonth(d.getUTCMonth() + i);
      months.push({ day: d.toISOString().slice(0, 10) });
    }
    expect(months[0].day).toBe("2025-09-01");
    expect(spendAxisTicks(0, months, "month")).toEqual({ day: "Sep", month: "2025" });
    expect(spendAxisTicks(4, months, "month")).toEqual({ day: "Jan", month: "2026" });
    expect(spendAxisTicks(5, months, "month")).toEqual({ day: "Feb", month: "" });
    expect(spendBucketLabel("2026-08-28", "day")).toBe("28 Aug");
    expect(spendBucketLabel("2026-08-24", "week")).toBe("Week of 24 Aug");
    expect(spendBucketLabel("2026-08-01", "month")).toBe("Aug 2026");
  });

  it("formatStatsHtml still wraps a full document", () => {
    const html = formatStatsHtml(stats());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("spend-board");
  });
});
