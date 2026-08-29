/**
 * Series for the inspect Spend page: daily D→I→K pipeline and billed runs.
 * UTC days, long enough to roll into weeks and months on the board.
 * Not a second definition of unread — uses extract_watermarks.
 */

import type { Db } from "../db/connection.js";
import { EXTRACT_WATERMARK_JOIN } from "../db/extract-watermarks.js";
import { getStats, type KnowledgeStats } from "../db/stats.js";
import { listIntelligenceRuns } from "../db/intelligence-runs.js";
import {
  addOptional,
  type IntelligenceRunSummary,
  type StageUsage,
} from "../intelligence/usage.js";
import type { TokenBudgetReport } from "../intelligence/token-budget.js";

/** Daily rows kept in the payload so the board can show 12 months of month-bars. */
export const SPEND_DASHBOARD_DAYS = 366;

export type SpendGrain = "day" | "week" | "month";

export const STAGE_HELP: Record<
  string,
  { title: string; does: string; when: string; group: "read" | "file" }
> = {
  extract: {
    title: "Reading chat",
    does: "Turns new conversation lines into draft facts. Usually the expensive part — a long chat is several runs.",
    when: "When chat is pulled in, and when you consolidate.",
    group: "read",
  },
  classify: {
    title: "Filing a note",
    does: "Chooses a folder (work, people, warehouse, …) for something you captured by hand. Chat extract already files as it goes.",
    when: "When a typed-in note had no folder.",
    group: "file",
  },
  entities: {
    title: "Naming things",
    does: "Picks out the people, projects, and places a typed-in note is about, so they show on the graph.",
    when: "When a typed-in note had no names yet.",
    group: "file",
  },
  reconcile: {
    title: "Matching memory",
    does: "Asks whether a new fact is already known, a duplicate, or extra detail on something you already have. One ask per new fact.",
    when: "When draft facts are turned into lasting memory.",
    group: "file",
  },
  supersede: {
    title: "Replacing old facts",
    does: "Catches updates (“moved to Porto” replaces “lives in Lisbon”) and keeps the history.",
    when: "Alongside matching memory.",
    group: "file",
  },
  summarise: {
    title: "Conversation recap",
    does: "Writes a short rolling recap and open threads. Cheap next to reading chat.",
    when: "After new lasting facts are written.",
    group: "file",
  },
};

export interface SpendDay {
  day: string;
  logged: number;
  examined: number;
  unread: number;
  staged: number;
  graduated: number;
  calls: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface SpendDashboard {
  window_days: number;
  unread_events: number;
  pending_facts: number;
  reclaimable_events: number;
  last_24h_calls: number;
  last_24h_input?: number;
  last_24h_output?: number;
  last_24h_elapsed_ms: number;
  days: SpendDay[];
  runs: IntelligenceRunSummary[];
  token_budget?: TokenBudgetReport;
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addUtcDays(day: string, delta: number): string {
  const t = new Date(`${day}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + delta);
  return utcDay(t);
}

/** Monday (UTC) of the ISO week, or the first of the calendar month. */
export function spendBucketKey(day: string, grain: SpendGrain): string {
  if (!day || day.length < 10) return day;
  const iso = day.slice(0, 10);
  if (grain === "day") return iso;
  if (grain === "month") return iso.slice(0, 7) + "-01";
  const t = new Date(iso + "T00:00:00.000Z");
  if (Number.isNaN(t.getTime())) return iso;
  const dow = t.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  t.setUTCDate(t.getUTCDate() + offset);
  return t.toISOString().slice(0, 10);
}

export function rollSpendDays(days: SpendDay[], grain: SpendGrain): SpendDay[] {
  if (grain === "day") return days;
  const map = new Map<string, SpendDay>();
  const order: string[] = [];
  for (const d of days) {
    const key = spendBucketKey(d.day, grain);
    let row = map.get(key);
    if (!row) {
      row = {
        day: key,
        logged: 0,
        examined: 0,
        unread: 0,
        staged: 0,
        graduated: 0,
        calls: 0,
      };
      map.set(key, row);
      order.push(key);
    }
    row.logged += d.logged;
    row.examined += d.examined;
    row.unread += d.unread;
    row.staged += d.staged;
    row.graduated += d.graduated;
    row.calls += d.calls;
    if (d.input_tokens != null) {
      row.input_tokens = (row.input_tokens || 0) + d.input_tokens;
    }
    if (d.output_tokens != null) {
      row.output_tokens = (row.output_tokens || 0) + d.output_tokens;
    }
  }
  const out: SpendDay[] = [];
  for (const key of order) {
    const row = map.get(key);
    if (row) out.push(row);
  }
  return out;
}

export function dayKey(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return utcDay(value);
  }
  if (typeof value === "string" && value.length >= 10) {
    const slice = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(slice) ? slice : null;
  }
  return null;
}

function emptyDay(day: string): SpendDay {
  return {
    day,
    logged: 0,
    examined: 0,
    unread: 0,
    staged: 0,
    graduated: 0,
    calls: 0,
  };
}

function fillDays(from: string, to: string): SpendDay[] {
  const out: SpendDay[] = [];
  for (let d = from; d <= to; d = addUtcDays(d, 1)) out.push(emptyDay(d));
  return out;
}

function bump(
  map: Map<string, SpendDay>,
  day: string,
  field: "logged" | "examined" | "unread" | "staged" | "graduated" | "calls",
  n = 1,
): void {
  const row = map.get(day);
  if (!row) return;
  row[field] += n;
}

export function spendDashboardFromStats(stats: KnowledgeStats): SpendDashboard {
  return {
    window_days: SPEND_DASHBOARD_DAYS,
    unread_events: stats.extract.unextracted_events,
    pending_facts: stats.pending_facts,
    reclaimable_events: stats.events.reclaimable.events,
    last_24h_calls: stats.intelligence.last_24h.calls,
    last_24h_input: stats.intelligence.last_24h.input_tokens,
    last_24h_output: stats.intelligence.last_24h.output_tokens,
    last_24h_elapsed_ms: stats.intelligence.last_24h.elapsed_ms,
    days: [],
    runs: stats.intelligence.recent,
    ...(stats.token_budget ? { token_budget: stats.token_budget } : {}),
  };
}

export async function loadSpendDashboard(
  db: Db,
  now = new Date(),
  windowDays = SPEND_DASHBOARD_DAYS,
): Promise<SpendDashboard> {
  const stats = await getStats(db);
  const today = utcDay(now);
  const from = addUtcDays(today, -(windowDays - 1));
  const cutoff = `${from}T00:00:00.000Z`;
  const days = fillDays(from, today);
  const byDay = new Map(days.map((d) => [d.day, d]));

  const eventRows = (await db
    .prepare(
      `SELECT e.created_at AS created_at, e.occurred_at AS occurred_at, e.sequence AS sequence,
              w.last_event_sequence AS mark
         FROM session_events e
         ${EXTRACT_WATERMARK_JOIN}
        WHERE COALESCE(e.created_at, '') >= ?`,
    )
    .all(cutoff)) as Array<{
    created_at: unknown;
    occurred_at: unknown;
    sequence: number;
    mark: number | null;
  }>;

  for (const row of eventRows) {
    const day = dayKey(row.created_at) ?? dayKey(row.occurred_at);
    if (!day) continue;
    bump(byDay, day, "logged");
    const mark = row.mark ?? 0;
    if (row.sequence <= mark) bump(byDay, day, "examined");
    else bump(byDay, day, "unread");
  }

  const stagedRows = (await db
    .prepare(`SELECT created_at FROM session_facts WHERE created_at >= ?`)
    .all(cutoff)) as Array<{ created_at: unknown }>;
  for (const row of stagedRows) {
    const day = dayKey(row.created_at);
    if (day) bump(byDay, day, "staged");
  }

  const graduatedRows = (await db
    .prepare(`SELECT created_at FROM facts WHERE created_at >= ?`)
    .all(cutoff)) as Array<{ created_at: unknown }>;
  for (const row of graduatedRows) {
    const day = dayKey(row.created_at);
    if (day) bump(byDay, day, "graduated");
  }

  let runs: IntelligenceRunSummary[] = [];
  try {
    const stored = await listIntelligenceRuns(db);
    const next = stored
      .filter((r) => r.created_at >= cutoff)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        created_at: r.created_at,
        consolidation_id: r.consolidation_id,
        calls: r.usage.calls,
        elapsed_ms: r.usage.elapsed_ms,
        stages: r.usage.stages,
        ...(r.usage.input_tokens != null ? { input_tokens: r.usage.input_tokens } : {}),
        ...(r.usage.output_tokens != null ? { output_tokens: r.usage.output_tokens } : {}),
        trigger: r.trigger ?? null,
        source_tool: r.source_tool ?? null,
        project: r.project ?? null,
      }));
    for (const run of next) {
      const day = dayKey(run.created_at);
      if (!day) continue;
      const slot = byDay.get(day);
      if (!slot) continue;
      slot.calls += run.calls;
      slot.input_tokens = addOptional(slot.input_tokens, run.input_tokens);
      slot.output_tokens = addOptional(slot.output_tokens, run.output_tokens);
    }
    runs = next;
  } catch {
    /* pre-v20 store or a failed list: days still load, spend is empty */
  }

  return {
    window_days: windowDays,
    unread_events: stats.extract.unextracted_events,
    pending_facts: stats.pending_facts,
    reclaimable_events: stats.events.reclaimable.events,
    last_24h_calls: stats.intelligence.last_24h.calls,
    last_24h_input: stats.intelligence.last_24h.input_tokens,
    last_24h_output: stats.intelligence.last_24h.output_tokens,
    last_24h_elapsed_ms: stats.intelligence.last_24h.elapsed_ms,
    days,
    runs,
    ...(stats.token_budget ? { token_budget: stats.token_budget } : {}),
  };
}

export function stagesIn(runs: IntelligenceRunSummary[]): string[] {
  const order = [
    "extract",
    "classify",
    "entities",
    "reconcile",
    "supersede",
    "summarise",
  ];
  const have = new Set<string>();
  for (const run of runs) {
    for (const name of Object.keys(run.stages)) have.add(name);
  }
  const out = order.filter((s) => have.has(s));
  for (const name of [...have].sort()) if (!out.includes(name)) out.push(name);
  return out;
}

export function stageTotals(runs: IntelligenceRunSummary[]): Record<string, StageUsage> {
  const out: Record<string, StageUsage> = {};
  for (const run of runs) {
    for (const [name, stage] of Object.entries(run.stages)) {
      const prev = out[name];
      out[name] = {
        provider: stage.provider,
        model: stage.model ?? prev?.model,
        calls: (prev?.calls ?? 0) + stage.calls,
        elapsed_ms: (prev?.elapsed_ms ?? 0) + stage.elapsed_ms,
        ...(addOptional(prev?.input_tokens, stage.input_tokens) != null
          ? { input_tokens: addOptional(prev?.input_tokens, stage.input_tokens) }
          : {}),
        ...(addOptional(prev?.output_tokens, stage.output_tokens) != null
          ? { output_tokens: addOptional(prev?.output_tokens, stage.output_tokens) }
          : {}),
      };
    }
  }
  return out;
}
