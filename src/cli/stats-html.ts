/**
 * Spend page for `openmemory inspect`. Catch-up vs cost.
 * Cost defaults to tokens (what providers bill and quota) when reported;
 * uses/time are alternatives. Grain then period on the chart.
 * More detail is Cost only: metric/filter rows plus the per-run table.
 */

import type { KnowledgeStats } from "../db/stats.js";
import {
  STAGE_HELP,
  rollSpendDays,
  spendBucketKey,
  spendDashboardFromStats,
  stageTotals,
  stagesIn,
  type SpendDashboard,
  type SpendGrain,
} from "./spend-dashboard.js";
import {
  TOKEN_BUDGET_HOW_TO,
  billedCapName,
  billedProviderName,
  formatResetAt,
  formatTokenCount,
  tokenBudgetUsageLead,
} from "../intelligence/token-budget.js";
import { LEDGER, LEDGER_MARK_SVG, ledgerFaviconHref, ledgerSpendCss } from "./inspect-theme.js";

export function spendBucketLabel(day: string, grain: SpendGrain = "day"): string {
  const p = (day || "").split("-");
  if (p.length < 3) return day;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[Number(p[1]) - 1] ?? "";
  if (grain === "month") return mon + " " + p[0];
  const d = String(Number(p[2]));
  if (grain === "week") return "Week of " + d + " " + mon;
  return d + " " + mon;
}

/** Day number plus a month name on the 1st (and the first bar). Sparse on long windows. */
export function spendAxisTicks(
  i: number,
  view: Array<{ day: string }>,
  grain: SpendGrain = "day",
): { day: string; month: string } {
  const n = view.length;
  const d = view[i];
  if (!d) return { day: "", month: "" };
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[Number(d.day.slice(5, 7)) - 1] ?? "";
  const year = d.day.slice(0, 4);
  const dayn = String(Number(d.day.slice(8)));
  if (grain === "month") {
    const yearBoundary = i === 0 || view[i - 1]!.day.slice(0, 4) !== year;
    return { day: mon, month: yearBoundary ? year : "" };
  }
  const monthBoundary = i === 0 || view[i - 1]!.day.slice(5, 7) !== d.day.slice(5, 7);
  if (n <= 8) return { day: `${dayn} ${mon}`, month: "" };
  const step = grain === "week" && n > 16 ? 4 : n <= 16 ? 2 : 5;
  const showDay = i % step === 0 || i === n - 1;
  return { day: showDay ? dayn : "", month: monthBoundary ? mon : "" };
}

const STAGE_COLOUR: Record<string, string> = { ...LEDGER.stage };

export const SPEND_BOARD_CSS = `
  .spend-board { max-width: 920px; margin: 0 auto; color: var(--ink, var(--text)); }
  .spend-hero { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  @media (max-width: 720px) { .spend-hero { grid-template-columns: 1fr; } }
  .spend-hero-card { background: var(--card, var(--elev)); border: 1px solid var(--line);
    border-radius: 12px; padding: 18px 18px 16px; }
  .spend-hero-card h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--muted);
    letter-spacing: .02em; text-transform: uppercase; }
  .spend-hero-card p { margin: 0 0 8px; font-size: 16px; line-height: 1.4; }
  .spend-hero-card p.lead { font-size: 22px; font-weight: 650; letter-spacing: -.02em; }
  .spend-hero-card.warn p.lead { color: var(--warn); }
  .spend-hero-card .do { color: var(--accent); font-size: 13px; margin: 10px 0 0; }
  .spend-card { background: var(--card, var(--elev)); border: 1px solid var(--line);
    border-radius: 12px; padding: 16px 18px 14px; margin-bottom: 12px; }
  .spend-toolbar { display: flex; flex-wrap: wrap; gap: 8px 0; align-items: center; margin-bottom: 10px; }
  .spend-cluster { display: flex; align-items: center; }
  .spend-split {
    width: 1px; height: 22px; margin: 0 12px; flex: 0 0 1px;
    background: var(--line); align-self: center;
  }
  .spend-seg {
    display: inline-flex; gap: 2px; padding: 3px; width: max-content; max-width: 100%;
    background: var(--input); border: 1px solid var(--line); border-radius: 8px;
  }
  .spend-board .spend-seg button {
    font-size: 12px; padding: 5px 10px; border: 1px solid transparent;
    background: transparent; border-radius: 6px;
  }
  .spend-board .spend-seg button.on {
    background: var(--chip, #243044); border-color: transparent;
    color: var(--accent);
  }
  #om-detail { font-size: 12px; padding: 5px 10px; }
  #om-detail.on { border-color: var(--accent); color: var(--accent); }
  .spend-toolbar .grow { margin-left: auto; }
  .spend-chart-title { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  #om-chart { width: 100%; height: auto; display: block; }
  .om-day { cursor: pointer; }
  .om-day:hover rect { filter: brightness(1.1); }
  .om-day.is-on rect { stroke: var(--text, #e7edf5); stroke-width: 1.25; }
  .spend-legend { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 10px 0 0; font-size: 12px; color: var(--muted); }
  .spend-legend button { border: 0; background: transparent; color: inherit; padding: 0; font: inherit; cursor: help; }
  .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  .spend-quiet { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
  .spend-board:not(.is-detail) .spend-detail-only { display: none !important; }
  .spend-board:not(.is-cost) #om-detail,
  .spend-board:not(.is-cost) .spend-detail-only { display: none !important; }
  .spend-board:not(.grain-day) .grain-day { display: none !important; }
  .spend-board:not(.grain-week) .grain-week { display: none !important; }
  .spend-board:not(.grain-month) .grain-month { display: none !important; }
  #om-tip {
    position: fixed; z-index: 4000; max-width: min(280px, calc(100vw - 16px));
    padding: 8px 10px; background: var(--elev, #1c2430); color: var(--text, #e7edf5);
    border: 1px solid var(--line); border-radius: 8px; font-size: 12px; line-height: 1.4;
    pointer-events: none; box-shadow: 0 10px 30px rgba(0,0,0,.4);
  }
  #om-tip strong { display: block; margin-bottom: 4px; font-size: 12px; }
  #om-advanced table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  #om-advanced th, #om-advanced td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  #om-advanced th { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  #om-advanced td.num { font-variant-numeric: tabular-nums; text-align: right; }
  #om-advanced .pill { display: inline-block; padding: 1px 6px; border-radius: 999px; background: var(--chip, #243044); font-size: 11px; }
  .spend-board button.spend-stage, .spend-stage {
    display: grid; grid-template-columns: 10.5rem 1fr 4.2rem; gap: 8px; align-items: center;
    font-size: 12px; border: 0; background: transparent; color: inherit; text-align: left;
    padding: 4px 0; cursor: help; font: inherit; width: 100%; border-radius: 0; }
  .spend-stage > span:first-child { white-space: nowrap; }
  .spend-board button.spend-stage:hover { border-color: transparent; color: inherit; }
  .spend-stage .track { display: block; height: 10px; background: var(--chip, #243044);
    border-radius: 5px; overflow: hidden; }
  .spend-stage .fill { display: block; height: 100%; width: 0; max-width: 100%;
    border-radius: 5px; min-width: 0; }
  .spend-stage .nm { font-variant-numeric: tabular-nums; text-align: right; color: var(--muted); }
  .spend-board:not(.is-cost) .cost-only { display: none !important; }
  .spend-board.is-cost .catch-only { display: none !important; }
  #om-chart-axis text { font-size: 10px; fill: var(--muted); }
  .spend-caps { margin: 12px 0 2px; display: flex; flex-direction: column; gap: 10px; }
  .spend-cap-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .spend-cap-row .nm { color: var(--muted); font-variant-numeric: tabular-nums; }
  .spend-cap .track { display: block; height: 10px; margin-top: 6px; background: var(--chip, #2a3126);
    border-radius: 5px; overflow: hidden; }
  .spend-cap .fill { display: block; height: 100%; width: 0; max-width: 100%;
    background: var(--accent); border-radius: 5px; }
  .spend-cap.is-full .fill { background: var(--warn); }
  .spend-cap.is-broken .track { opacity: 0.45; }
`;

function isDashboard(input: SpendDashboard | KnowledgeStats): input is SpendDashboard {
  return Array.isArray((input as SpendDashboard).days);
}

export function renderSpendBoard(
  input: SpendDashboard | KnowledgeStats,
  generatedAt = new Date(),
): string {
  const data = isDashboard(input) ? input : spendDashboardFromStats(input);
  const json = JSON.stringify(payloadOf(data, generatedAt)).replace(/</g, "\\u003c");
  const startCost = Boolean(data.token_budget?.tightest);
  return `<div class="spend-board grain-day${startCost ? " is-cost" : ""}" id="om-spend">
<script type="application/json" id="om-spend-json">${json}</script>
${hero(data)}
<div class="spend-card">
  <div class="spend-toolbar">
    <div class="spend-cluster">
      <div class="spend-seg" id="om-mode" role="group" aria-label="What to show">
        <button type="button" data-mode="catchup"${startCost ? "" : ' class="on"'}>Catch-up</button>
        <button type="button" data-mode="cost"${startCost ? ' class="on"' : ""}>Cost</button>
      </div>
    </div>
    <span class="spend-split" aria-hidden="true"></span>
    <div class="spend-cluster">
      <div class="spend-seg" id="om-grain" role="group" aria-label="Bar size">
        <button type="button" data-grain="day" class="on">Day</button>
        <button type="button" data-grain="week">Week</button>
        <button type="button" data-grain="month">Month</button>
      </div>
    </div>
    <span class="spend-split" aria-hidden="true"></span>
    <div class="spend-cluster">
      <div class="spend-seg grain-day" id="om-period-day" role="group" aria-label="How far back">
        <button type="button" data-period="7">7 days</button>
        <button type="button" data-period="14" class="on">14 days</button>
        <button type="button" data-period="30">30 days</button>
      </div>
      <div class="spend-seg grain-week" id="om-period-week" role="group" aria-label="How far back">
        <button type="button" data-period="8">8 weeks</button>
        <button type="button" data-period="12" class="on">12 weeks</button>
        <button type="button" data-period="26">26 weeks</button>
      </div>
      <div class="spend-seg grain-month" id="om-period-month" role="group" aria-label="How far back">
        <button type="button" data-period="6">6 months</button>
        <button type="button" data-period="12" class="on">12 months</button>
      </div>
    </div>
    <button type="button" class="grow cost-only" id="om-detail">More detail</button>
  </div>
  <p class="spend-chart-title" id="om-chart-title">${startCost ? "Tokens the model read" : "Chat written, and how much is still waiting"}</p>
  <div class="spend-seg catch-only" id="om-catch-metric" role="group" aria-label="Catch-up units" style="margin:0 0 8px">
    <button type="button" data-cmetric="waiting" class="on">Waiting vs read</button>
    <button type="button" data-cmetric="facts">Facts written</button>
  </div>
  <div class="spend-seg cost-only spend-detail-only" id="om-metrics" role="group" aria-label="Cost units" style="margin-bottom:8px">
    <button type="button" data-metric="tokens">Tokens</button>
    <button type="button" data-metric="calls">Uses</button>
    <button type="button" data-metric="time">Time</button>
  </div>
  <div class="spend-seg cost-only spend-detail-only" id="om-filter" role="group" aria-label="Which work" style="margin-bottom:8px">
    <button type="button" data-filter="all" class="on">All work</button>
    <button type="button" data-filter="read">Reading chat</button>
    <button type="button" data-filter="file">Filing memory</button>
  </div>
  <svg id="om-chart" viewBox="0 0 720 228" role="img" aria-label="Activity by day"></svg>
  <div class="spend-legend" id="om-legend"></div>
</div>
<div class="spend-card">
  <p class="spend-chart-title" id="om-day-title">That day</p>
  <div id="om-stage-bars"></div>
  <p class="spend-quiet" id="om-day-note"></p>
</div>
<div class="spend-card spend-detail-only" id="om-advanced">
  <p class="spend-quiet">Each model run in this bar</p>
  <div id="om-runs"></div>
</div>
<div id="om-tip" hidden></div>
</div>
<script>${SPEND_BOARD_JS}</script>`;
}

export function formatStatsHtml(stats: KnowledgeStats, generatedAt = new Date()): string {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenMemory spend</title>
<link rel="icon" href="${ledgerFaviconHref()}"/>
<style>
${ledgerSpendCss()}
  html, body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.45 "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
  .spend-brand { display: flex; align-items: center; gap: 10px; padding: 16px 20px 0;
    max-width: 920px; margin: 0 auto; }
  .spend-brand svg { display: block; width: 28px; height: 28px; border-radius: 6px; }
  .spend-brand h1 { font-size: 15px; font-weight: 650; letter-spacing: -0.02em; margin: 0; }
  .spend-brand p { margin: 1px 0 0; font-size: 11px; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--muted); }
  main { padding: 20px 20px 56px; }
  ${SPEND_BOARD_CSS}
</style>
</head>
<body>
<div class="spend-brand">
  <span>${LEDGER_MARK_SVG}</span>
  <div>
    <h1>OpenMemory</h1>
    <p>Spend</p>
  </div>
</div>
<main>${renderSpendBoard(stats, generatedAt)}</main>
</body>
</html>
`;
}

function payloadOf(data: SpendDashboard, generatedAt: Date) {
  const stages = stagesIn(data.runs);
  const totals = stageTotals(data.runs);
  const since = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const last24Runs = data.runs.filter((r) => r.created_at >= since);
  const last24Stages = stageTotals(last24Runs);
  let topId = "";
  let topCalls = 0;
  for (const [id, s] of Object.entries(last24Stages)) {
    if (s.calls > topCalls) {
      topCalls = s.calls;
      topId = id;
    }
  }
  const hasTokens = data.days.some((d) => d.input_tokens != null) ||
    data.last_24h_input != null;
  return {
    days: data.days,
    runs: data.runs,
    unread: data.unread_events,
    pending: data.pending_facts,
    reclaimable: data.reclaimable_events,
    last24: {
      calls: data.last_24h_calls,
      input: data.last_24h_input ?? null,
      output: data.last_24h_output ?? null,
      elapsed: data.last_24h_elapsed_ms,
      top: topId,
      topCalls,
    },
    hasTokens,
    budget: data.token_budget ?? null,
    stages: stages.map((id) => {
      const help = STAGE_HELP[id];
      return {
        id,
        colour: STAGE_COLOUR[id] ?? "#8b98a8",
        calls: totals[id]?.calls ?? 0,
        group: help?.group ?? "file",
        title: help?.title ?? id,
        does: help?.does ?? "A step of turning chat into memory.",
        when: help?.when ?? "",
      };
    }),
  };
}

function hero(data: SpendDashboard): string {
  const unread = data.unread_events;
  const pending = data.pending_facts;
  const calls = data.last_24h_calls;
  const catchLead = unread === 0
    ? "Caught up."
    : `${fmtInt(unread)} chat lines still waiting.`;
  const catchBody = unread === 0
    ? "Everything logged has been read into draft memory."
    : "Those lines are in the store but have not been turned into facts yet.";
  const catchDo = unread === 0
    ? pending > 0
      ? `${fmtInt(pending)} drafts are waiting to become lasting facts — run a full consolidate.`
      : "Nothing you need to do."
    : "Run consolidate when you want catch-up. That uses the model.";
  const tokens = data.last_24h_input;
  const costLead = tokens != null && tokens > 0
    ? `${compact(tokens)} tokens in the last day.`
    : calls === 0
      ? "Quiet day."
      : `${fmtInt(calls)} model uses in the last day.`;
  const budget = data.token_budget;
  const tight = budget?.tightest;
  const unmetered = Boolean(
    budget?.providers && Object.values(budget.providers).some((p) => p?.unmetered),
  );
  const capSpent = Boolean(tight && tight.remaining <= 0);
  const costWarn = capSpent || unmetered;
  let costLeadBudget = costLead;
  let costBody = tokens != null && tokens > 0
    ? `${fmtInt(calls)} uses in the last 24 hours. Embeddings are not counted.`
    : calls === 0
      ? "No billed consolidation in the last 24 hours."
      : `The model did not report tokens. ${fmtInt(calls)} uses in the last 24 hours.`;
  if (unmetered) {
    costLeadBudget = "Tokens were not reported, so billed extract is paused.";
    costBody = "";
  } else if (tight) {
    const lines = tokenBudgetUsageLead(tight);
    costLeadBudget = lines.lead;
    costBody = capSpent
      ? `Billed extract is paused until it ${
          tight.resets_at ? `resets ${formatResetAt(tight.resets_at)}` : "ages"
        }, or you raise the cap.`
      : lines.detail;
  }
  const howTo = budget?.how_to ?? TOKEN_BUDGET_HOW_TO;
  const reclaim = data.reclaimable_events > 0
    ? `<p class="do">${fmtInt(data.reclaimable_events)} old lines can be deleted with prune — dry-run first.</p>`
    : "";
  return `<div class="spend-hero">
    <div class="spend-hero-card${unread > 0 ? " warn" : ""}">
      <h2>Catch-up</h2>
      <p class="lead">${esc(catchLead)}</p>
      <p>${esc(catchBody)}</p>
      <p class="do">${esc(catchDo)}</p>
    </div>
    <div class="spend-hero-card${costWarn ? " warn" : ""}">
      <h2>Cost</h2>
      <p class="lead">${esc(costLeadBudget)}</p>
      ${capMeters(data)}
      ${costBody ? `<p>${esc(costBody)}</p>` : ""}
      <p class="do">${howToHtml(howTo)}</p>
      ${reclaim}
    </div>
  </div>`;
}

function capMeters(data: SpendDashboard): string {
  const budget = data.token_budget;
  if (!budget) return "";
  const rows: string[] = [];
  for (const [provider, slice] of Object.entries(budget.providers)) {
    if (!slice) continue;
    if (slice.unmetered) {
      rows.push(
        `<div class="spend-cap is-broken" role="img" aria-label="${esc(billedProviderName(provider))}: tokens were not reported">` +
          `<div class="spend-cap-row"><span>${esc(billedProviderName(provider))}</span>` +
          `<span class="nm">not reported</span></div>` +
          `<span class="track"></span></div>`,
      );
      continue;
    }
    for (const w of slice.windows) {
      const pct = w.cap > 0 ? Math.min(100, (100 * w.used) / w.cap) : 0;
      const full = w.remaining <= 0;
      const name = billedCapName(provider, w.scale);
      const used = `${compact(w.used)} used · ${compact(w.remaining)} remaining`;
      rows.push(
        `<div class="spend-cap${full ? " is-full" : ""}" role="img" aria-label="${esc(name)}: ${esc(used)}">` +
          `<div class="spend-cap-row"><span>${esc(name)}</span>` +
          `<span class="nm">${esc(used)}</span></div>` +
          `<span class="track"><span class="fill" style="width:${pct.toFixed(1)}%"></span></span></div>`,
      );
    }
  }
  return rows.length ? `<div class="spend-caps">${rows.join("")}</div>` : "";
}

function howToHtml(text: string): string {
  return text.split("\n").map((line) => esc(line)).join("<br>");
}

function compact(n: number | undefined): string {
  if (n == null) return "—";
  return formatTokenCount(n);
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SPEND_BOARD_JS = `(function(){
  var C = ${JSON.stringify({
    drafts: LEDGER.stage.classify,
    lasting: LEDGER.stage.entities,
    waiting: LEDGER.stage.extract,
    muted: LEDGER.dark.muted,
  })};
  var box = document.getElementById("om-spend-json");
  if (!box) return;
  var D;
  try { D = JSON.parse(box.textContent || "{}"); } catch (err) { return; }
  var days = D.days || [];
  var runs = D.runs || [];
  var stages = D.stages || [];
  var spendBucketKey = ${spendBucketKey.toString()};
  var rollSpendDays = ${rollSpendDays.toString()};
  var spendBucketLabel = ${spendBucketLabel.toString()};
  var grain = "day";
  var periodByGrain = { day: 14, week: 12, month: 12 };
  var mode = D.budget && D.budget.tightest ? "cost" : "catchup";
  var metric = D.hasTokens ? "tokens" : "calls";
  var cmetric = "waiting";
  var filter = "all";
  var detail = false;
  var selected = null;
  var chart = document.getElementById("om-chart");
  var legend = document.getElementById("om-legend");
  var title = document.getElementById("om-chart-title");
  var dayTitle = document.getElementById("om-day-title");
  var dayNote = document.getElementById("om-day-note");
  var bars = document.getElementById("om-stage-bars");
  var runsEl = document.getElementById("om-runs");
  var root = document.getElementById("om-spend");
  var tip = document.getElementById("om-tip");
  if (tip && tip.parentNode !== document.body) document.body.appendChild(tip);

  function fmt(n){ return Math.round(n).toLocaleString("en-GB"); }
  var formatTokenCount = ${formatTokenCount.toString()};
  function compact(n){
    if (n == null) return "—";
    return formatTokenCount(n);
  }
  function whoRan(t){
    if (t === "cli") return "CLI";
    if (t === "mcp") return "MCP";
    if (t === "scheduler") return "scheduler";
    return "—";
  }
  function niceDay(iso){ return spendBucketLabel(iso, grain); }
  function fmtTime(ms){
    if (ms == null) return "—";
    if (ms >= 60000) {
      var m = Math.floor(ms / 60000);
      var s = Math.round((ms % 60000) / 1000);
      return s ? m + "m " + s + "s" : m + "m";
    }
    if (ms >= 1000) return (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + "s";
    return fmt(ms) + " ms";
  }
  function fmtMetric(n){
    if (metric === "tokens") return compact(n);
    if (metric === "time") return fmtTime(n);
    return fmt(n);
  }
  function viewDays(){
    var rolled = rollSpendDays(days, grain);
    var n = periodByGrain[grain] || 14;
    if (rolled.length <= n) return rolled;
    return rolled.slice(rolled.length - n);
  }
  function activeStages(){
    if (filter === "read") return stages.filter(function(s){ return s.group === "read"; });
    if (filter === "file") return stages.filter(function(s){ return s.group === "file"; });
    return stages;
  }
  function dayRuns(bucket){
    return runs.filter(function(r){
      return spendBucketKey((r.created_at || "").slice(0, 10), grain) === bucket;
    });
  }
  function stageAmt(st, list){
    var n = 0;
    list.forEach(function(r){
      var x = r.stages && r.stages[st.id];
      if (!x) return;
      if (metric === "tokens") n += x.input_tokens || 0;
      else if (metric === "time") n += x.elapsed_ms || 0;
      else n += x.calls;
    });
    return n;
  }
  function dayValue(d){
    if (mode === "catchup") return cmetric === "facts" ? (d.staged + d.graduated) : d.logged;
    if (metric === "tokens") {
      if (filter === "all") return d.input_tokens || 0;
      var n = 0;
      activeStages().forEach(function(s){ n += stageAmt(s, dayRuns(d.day)); });
      return n;
    }
    if (metric === "time") {
      var ms = 0;
      dayRuns(d.day).forEach(function(r){
        if (filter === "all") { ms += r.elapsed_ms || 0; return; }
        activeStages().forEach(function(s){ ms += stageAmt(s, [r]); });
      });
      return ms;
    }
    if (filter === "all") return d.calls;
    var c = 0;
    activeStages().forEach(function(s){ c += stageAmt(s, dayRuns(d.day)); });
    return c;
  }
  var axisTicks = ${spendAxisTicks.toString()};
  function axisY(lab){
    if (mode === "cost" && metric === "time") {
      return lab >= 60000 ? Math.round(lab / 60000) + "m" : Math.round(lab / 1000) + "s";
    }
    if ((mode === "cost" && metric === "tokens") || lab >= 10000) return compact(lab);
    return String(lab);
  }
  function placeTip(ev){
    if (!tip) return;
    var pad = 14;
    var tw = tip.offsetWidth || 240;
    var th = tip.offsetHeight || 72;
    var x = ev.clientX + pad;
    var y = ev.clientY + pad;
    if (x + tw > innerWidth - 8) x = ev.clientX - tw - pad;
    if (y + th > innerHeight - 8) y = ev.clientY - th - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function showTip(ev, html){
    if (!tip) return;
    tip.hidden = false;
    tip.innerHTML = html;
    placeTip(ev);
  }
  function hideTip(){ if (tip) tip.hidden = true; }

  function draw(){
    if (!chart) return;
    var view = viewDays();
    var w = 720, h = 228, l = 44, r = 10, t = 10, b = 42;
    var iw = w - l - r, ih = h - t - b;
    var max = 0;
    for (var i = 0; i < view.length; i++) {
      var v = dayValue(view[i]);
      if (v > max) max = v;
    }
    var slot = iw / Math.max(view.length, 1);
    var bw = Math.min(slot * 0.72, grain === "day" ? 26 : 52);
    var svg = "";
    if (max <= 0) {
      var yZero = t + ih;
      svg += '<line x1="'+l+'" x2="'+(w-r)+'" y1="'+yZero+'" y2="'+yZero+'" stroke="var(--line)"/>';
      svg += '<text x="'+(l-6)+'" y="'+(yZero+3)+'" text-anchor="end" fill="var(--muted)" font-size="10">0</text>';
    } else {
      for (var g = 0; g <= 4; g++){
        var y = t + ih * g / 4;
        var lab = Math.round(max * (4 - g) / 4);
        svg += '<line x1="'+l+'" x2="'+(w-r)+'" y1="'+y+'" y2="'+y+'" stroke="var(--line)"/>';
        svg += '<text x="'+(l-6)+'" y="'+(y+3)+'" text-anchor="end" fill="var(--muted)" font-size="10">'+axisY(lab)+'</text>';
      }
    }
    for (var i = 0; i < view.length; i++){
      var d = view[i];
      var x = l + slot * i + (slot - bw) / 2;
      var on = selected === d.day ? " is-on" : "";
      svg += '<g class="om-day'+on+'" data-day="'+d.day+'">';
      if (mode === "catchup" && cmetric === "facts"){
        var stH = max ? d.staged / max * ih : 0;
        var gH = max ? d.graduated / max * ih : 0;
        var yS = t + ih - gH - stH;
        var yG = t + ih - gH;
        if (stH > 0) svg += '<rect x="'+x+'" y="'+yS+'" width="'+bw+'" height="'+stH+'" fill="'+C.drafts+'" rx="2"/>';
        if (gH > 0) svg += '<rect x="'+x+'" y="'+yG+'" width="'+bw+'" height="'+gH+'" fill="'+C.lasting+'" rx="2"/>';
        if (d.staged + d.graduated === 0) svg += '<rect x="'+x+'" y="'+(t+ih-2)+'" width="'+bw+'" height="2" fill="var(--line)"/>';
      } else if (mode === "catchup"){
        var examH = max ? d.examined / max * ih : 0;
        var unreadH = max ? d.unread / max * ih : 0;
        var yU = t + ih - examH - unreadH;
        var yE = t + ih - examH;
        if (unreadH > 0) svg += '<rect x="'+x+'" y="'+yU+'" width="'+bw+'" height="'+unreadH+'" fill="'+C.waiting+'" rx="2"/>';
        if (examH > 0) svg += '<rect x="'+x+'" y="'+yE+'" width="'+bw+'" height="'+examH+'" fill="'+C.lasting+'" rx="2"/>';
        if (d.logged === 0) svg += '<rect x="'+x+'" y="'+(t+ih-2)+'" width="'+bw+'" height="2" fill="var(--line)"/>';
      } else {
        var y = t + ih;
        var st = activeStages();
        var list = dayRuns(d.day);
        st.forEach(function(s){
          var c = stageAmt(s, list);
          var bh = max ? c / max * ih : 0;
          if (bh <= 0) return;
          y -= bh;
          svg += '<rect x="'+x+'" y="'+y+'" width="'+bw+'" height="'+bh+'" fill="'+s.colour+'" rx="1"/>';
        });
        if (dayValue(d) === 0) svg += '<rect x="'+x+'" y="'+(t+ih-2)+'" width="'+bw+'" height="2" fill="var(--line)"/>';
      }
      var ax = axisTicks(i, view, grain);
      var cx = x + bw / 2;
      if (ax.month) {
        if (ax.day) svg += '<text x="'+cx+'" y="'+(h-22)+'" text-anchor="middle" fill="var(--muted)" font-size="10">'+ax.day+'</text>';
        svg += '<text x="'+cx+'" y="'+(h-8)+'" text-anchor="middle" fill="var(--muted)" font-size="10" font-weight="600">'+ax.month+'</text>';
      } else if (ax.day) {
        svg += '<text x="'+cx+'" y="'+(h-12)+'" text-anchor="middle" fill="var(--muted)" font-size="10">'+ax.day+'</text>';
      }
      svg += '</g>';
    }
    chart.innerHTML = svg;
    chart.querySelectorAll(".om-day").forEach(function(g){
      g.addEventListener("mousemove", function(ev){
        var day = g.getAttribute("data-day");
        var d = view.find(function(x){ return x.day === day; });
        if (!d) return;
        var html;
        if (mode === "catchup" && cmetric === "facts"){
          html = "<strong>"+niceDay(d.day)+"</strong>"+fmt(d.staged)+" drafts · "+fmt(d.graduated)+" lasting facts";
        } else if (mode === "catchup"){
          html = "<strong>"+niceDay(d.day)+"</strong>"+fmt(d.logged)+" new lines<br>"+
            fmt(d.examined)+" read · "+fmt(d.unread)+" waiting";
        } else if (metric === "tokens"){
          html = "<strong>"+niceDay(d.day)+"</strong>"+compact(dayValue(d))+" tokens in";
        } else if (metric === "time"){
          html = "<strong>"+niceDay(d.day)+"</strong>"+fmtTime(dayValue(d));
        } else {
          html = "<strong>"+niceDay(d.day)+"</strong>"+fmt(dayValue(d))+" uses";
        }
        showTip(ev, html);
      });
      g.addEventListener("mouseleave", hideTip);
      g.addEventListener("click", function(){
        selected = g.getAttribute("data-day");
        render();
      });
    });
  }

  function legendHtml(){
    if (!legend) return;
    if (mode === "catchup" && cmetric === "facts"){
      legend.innerHTML = '<span><i class="sw" style="background:'+C.drafts+'"></i>Drafts</span>'+
        '<span><i class="sw" style="background:'+C.lasting+'"></i>Lasting facts</span>';
      return;
    }
    if (mode === "catchup"){
      legend.innerHTML = '<span><i class="sw" style="background:'+C.lasting+'"></i>Already read</span>'+
        '<span><i class="sw" style="background:'+C.waiting+'"></i>Still waiting</span>';
      return;
    }
    legend.innerHTML = activeStages().map(function(s){
      return '<button type="button" data-stage="'+s.id+'"><i class="sw" style="background:'+s.colour+'"></i>'+s.title+'</button>';
    }).join("");
    legend.querySelectorAll("button").forEach(function(b){
      b.addEventListener("mousemove", function(ev){
        var s = stages.find(function(x){ return x.id === b.getAttribute("data-stage"); });
        if (s) showTip(ev, "<strong>"+s.title+"</strong>"+s.does+(s.when ? "<br>"+s.when : ""));
      });
      b.addEventListener("mouseleave", hideTip);
    });
  }

  function pickDay(){
    var view = viewDays();
    var day = selected;
    var hit = null;
    if (day) {
      hit = view.find(function(x){ return x.day === day; }) || null;
      if (!hit) {
        var mapped = spendBucketKey(day, grain);
        hit = view.find(function(x){ return x.day === mapped; }) || null;
      }
    }
    if (!hit) {
      for (var i = view.length - 1; i >= 0; i--) {
        if (view[i].logged || view[i].calls || view[i].staged || view[i].graduated) {
          hit = view[i];
          break;
        }
      }
      if (!hit && view.length) hit = view[view.length - 1];
    }
    selected = hit ? hit.day : null;
    return hit;
  }
  function paintBars(rows, withTip){
    if (!bars) return;
    var max = 1;
    rows.forEach(function(r){ if (r.n > max) max = r.n; });
    bars.innerHTML = rows.map(function(r){
      var pct = 100 * r.n / max;
      var attr = withTip && r.id ? ' data-stage="'+r.id+'"' : "";
      return '<button type="button" class="spend-stage"'+attr+'>'+
        '<span>'+r.title+'</span>'+
        '<span class="track"><span class="fill" style="width:'+pct.toFixed(1)+'%;background:'+r.colour+'"></span></span>'+
        '<span class="nm">'+r.label+'</span></button>';
    }).join("") || '<p class="spend-quiet">Nothing to show.</p>';
    if (!withTip) return;
    bars.querySelectorAll(".spend-stage").forEach(function(b){
      b.addEventListener("mousemove", function(ev){
        var s = stages.find(function(x){ return x.id === b.getAttribute("data-stage"); });
        if (s) showTip(ev, "<strong>"+s.title+"</strong>"+s.does+(s.when ? "<br>"+s.when : ""));
      });
      b.addEventListener("mouseleave", hideTip);
    });
  }
  function writeDay(){
    var d = pickDay();
    if (dayTitle) dayTitle.textContent = d ? niceDay(d.day) : "That day";
    if (!d){
      if (bars) bars.innerHTML = '<p class="spend-quiet">No activity in this window.</p>';
      if (dayNote) dayNote.textContent = "";
      if (runsEl) runsEl.innerHTML = "";
      return;
    }
    selected = d.day;
    if (mode === "catchup"){
      if (cmetric === "facts"){
        paintBars([
          { title: "Drafts", n: d.staged, colour: C.drafts, label: fmt(d.staged) },
          { title: "Lasting facts", n: d.graduated, colour: C.lasting, label: fmt(d.graduated) }
        ], false);
        if (dayNote) dayNote.textContent = "Click another bar to compare.";
      } else {
        paintBars([
          { title: "New chat", n: d.logged, colour: C.muted, label: fmt(d.logged) },
          { title: "Already read", n: d.examined, colour: C.lasting, label: fmt(d.examined) },
          { title: "Still waiting", n: d.unread, colour: C.waiting, label: fmt(d.unread) }
        ], false);
        if (dayNote) dayNote.textContent = "Click another bar to compare.";
      }
    } else {
      var list = dayRuns(d.day);
      var st = activeStages();
      if (!list.length || !st.length){
        if (bars) bars.innerHTML = '<p class="spend-quiet">No model work in this bar.</p>';
      } else {
        paintBars(st.map(function(s){
          var n = stageAmt(s, list);
          return { title: s.title, n: n, colour: s.colour, id: s.id, label: fmtMetric(n) };
        }), true);
      }
      if (dayNote) {
        dayNote.textContent = metric === "tokens"
          ? "Longer bar = more tokens that step read."
          : metric === "time"
            ? "Longer bar = more time that step took, not the bill."
            : "Longer bar = more times that step ran.";
      }
    }
    writeRuns(d.day);
  }
  function writeRuns(day){
    if (!runsEl) return;
    var list = dayRuns(day);
    if (!list.length){
      runsEl.innerHTML = '<p class="spend-quiet">No model run in this bar.</p>';
      return;
    }
    var html = '<table><thead><tr><th>When</th><th>Who</th><th></th><th>Tokens in</th><th>Out</th><th>Uses</th><th>Time</th><th>What ran</th></tr></thead><tbody>';
    list.forEach(function(r){
      var bits = [];
      Object.keys(r.stages || {}).forEach(function(k){
        var s = r.stages[k];
        var help = stages.find(function(x){ return x.id === k; });
        var who = s.model ? (s.provider+"/"+s.model) : s.provider;
        var amt = metric === "tokens"
          ? compact(s.input_tokens || 0)+" tok"
          : metric === "time"
            ? fmtTime(s.elapsed_ms || 0)
            : "× "+s.calls;
        bits.push((help ? help.title : k)+" "+amt+" ("+who+")");
      });
      html += '<tr><td>'+r.created_at.replace("T"," ").replace(".000Z"," UTC").replace("Z"," UTC")+'</td>'+
        '<td>'+whoRan(r.trigger)+'</td>'+
        '<td><span class="pill">'+r.kind+'</span></td>'+
        '<td class="num">'+(r.input_tokens == null ? "—" : compact(r.input_tokens))+'</td>'+
        '<td class="num">'+(r.output_tokens == null ? "—" : compact(r.output_tokens))+'</td>'+
        '<td class="num">'+fmt(r.calls)+'</td>'+
        '<td class="num">'+fmtTime(r.elapsed_ms)+'</td>'+
        '<td>'+bits.join("<br>")+'</td></tr>';
    });
    html += '</tbody></table>';
    runsEl.innerHTML = html;
  }

  function chartTitle(){
    if (!title) return;
    if (mode === "catchup") {
      title.textContent = cmetric === "facts"
        ? "Drafts and lasting facts written"
        : "Chat written, and how much is still waiting";
      return;
    }
    if (metric === "tokens") title.textContent = "Tokens the model read";
    else if (metric === "time") title.textContent = "How long the model ran";
    else title.textContent = "How often the model ran";
  }

  function syncPeriodButtons(id, current){
    document.querySelectorAll("#" + id + " button").forEach(function(x){
      x.classList.toggle("on", Number(x.getAttribute("data-period")) === current);
    });
  }
  function render(){
    if (root) {
      root.classList.toggle("is-detail", detail);
      root.classList.toggle("is-cost", mode === "cost");
      root.classList.toggle("grain-day", grain === "day");
      root.classList.toggle("grain-week", grain === "week");
      root.classList.toggle("grain-month", grain === "month");
    }
    var det = document.getElementById("om-detail");
    if (det) det.classList.toggle("on", detail);
    document.querySelectorAll("#om-mode button").forEach(function(x){
      x.classList.toggle("on", x.getAttribute("data-mode") === mode);
    });
    document.querySelectorAll("#om-grain button").forEach(function(x){
      x.classList.toggle("on", x.getAttribute("data-grain") === grain);
    });
    syncPeriodButtons("om-period-day", periodByGrain.day);
    syncPeriodButtons("om-period-week", periodByGrain.week);
    syncPeriodButtons("om-period-month", periodByGrain.month);
    document.querySelectorAll("#om-metrics button").forEach(function(x){
      var m = x.getAttribute("data-metric");
      if (m === "tokens") x.hidden = !D.hasTokens;
      x.classList.toggle("on", m === metric);
    });
    document.querySelectorAll("#om-catch-metric button").forEach(function(x){
      x.classList.toggle("on", x.getAttribute("data-cmetric") === cmetric);
    });
    pickDay();
    chartTitle();
    draw();
    legendHtml();
    writeDay();
  }

  document.querySelectorAll("#om-mode button").forEach(function(b){
    b.addEventListener("click", function(){
      mode = b.getAttribute("data-mode") || "catchup";
      document.querySelectorAll("#om-mode button").forEach(function(x){ x.classList.toggle("on", x === b); });
      render();
    });
  });
  document.querySelectorAll("#om-grain button").forEach(function(b){
    b.addEventListener("click", function(){
      grain = b.getAttribute("data-grain") || "day";
      render();
    });
  });
  document.querySelectorAll("#om-spend [data-period]").forEach(function(b){
    b.addEventListener("click", function(){
      var n = Number(b.getAttribute("data-period"));
      if (n) periodByGrain[grain] = n;
      render();
    });
  });
  document.querySelectorAll("#om-catch-metric button").forEach(function(b){
    b.addEventListener("click", function(){
      cmetric = b.getAttribute("data-cmetric") || "waiting";
      render();
    });
  });
  document.querySelectorAll("#om-metrics button").forEach(function(b){
    b.addEventListener("click", function(){
      metric = b.getAttribute("data-metric") || "calls";
      render();
    });
  });
  document.querySelectorAll("#om-filter button").forEach(function(b){
    b.addEventListener("click", function(){
      filter = b.getAttribute("data-filter") || "all";
      document.querySelectorAll("#om-filter button").forEach(function(x){ x.classList.toggle("on", x === b); });
      render();
    });
  });
  var detBtn = document.getElementById("om-detail");
  if (detBtn) detBtn.addEventListener("click", function(){ detail = !detail; render(); });
  render();
})();`;
