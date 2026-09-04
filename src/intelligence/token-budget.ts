/**
 * Optional windowed cap on billed intelligence. Unset = unlimited.
 * Tokens are not bytes — do not import parseDiskBudget.
 */

import type { Db } from "../db/connection.js";
import type { IntelligenceConfig } from "../types/config.js";
import type { StoredIntelligenceRun } from "./usage.js";

const bound = new WeakMap<object, ParsedTokenBudget>();

export const BILLED_PROVIDERS = ["cli", "sampling", "api"] as const;
export type BilledProvider = (typeof BILLED_PROVIDERS)[number];

export const TOKEN_WINDOWS = ["hour", "day", "week", "month"] as const;
export type TokenWindow = (typeof TOKEN_WINDOWS)[number];

export const TOKEN_WINDOW_MS: Record<TokenWindow, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export const TOKEN_WINDOW_LABEL: Record<TokenWindow, string> = {
  hour: "last hour",
  day: "last 24 hours",
  week: "last 7 days",
  month: "last 30 days",
};

/** Name of the cap itself, not the lookback that fills it. */
export const TOKEN_WINDOW_CAP: Record<TokenWindow, string> = {
  hour: "hourly cap",
  day: "daily cap",
  week: "weekly cap",
  month: "monthly cap",
};

/** Display name for a billed provider. `cli` is the CLI, not the letters c-l-i. */
export function billedProviderName(provider: string): string {
  if (provider === "cli") return "CLI";
  if (provider === "api") return "API";
  return provider;
}

/** "for the CLI" / "for sampling" — remaining-room sentences. */
export function forBilledProvider(provider: string): string {
  if (provider === "cli" || provider === "api") {
    return `for the ${billedProviderName(provider)}`;
  }
  return `for ${provider}`;
}

/** "CLI weekly cap" — remaining is room under this rolling cap. */
export function billedCapName(provider: string, scale: TokenWindow): string {
  return `${billedProviderName(provider)} ${TOKEN_WINDOW_CAP[scale]}`;
}

/** When oldest billed usage in the window ages out (UTC, en-GB). */
export function formatResetAt(iso: string, now = new Date()): string {
  const t = new Date(iso);
  const soon = t.getTime() - now.getTime() < 36 * 60 * 60 * 1000;
  return t.toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(soon
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
      : {}),
  });
}

export function tokenBudgetUsageLead(opts: {
  provider: string;
  scale: TokenWindow;
  used: number;
  remaining: number;
  cap: number;
  resets_at: string | null;
  now?: Date;
}): { lead: string; detail: string } {
  const capName = billedCapName(opts.provider, opts.scale);
  const lead =
    `${formatTokenCount(opts.used)} used · ${formatTokenCount(opts.remaining)} remaining`;
  const reset = opts.resets_at
    ? ` · resets ${formatResetAt(opts.resets_at, opts.now)}`
    : "";
  return {
    lead,
    detail: `${formatTokenCount(opts.cap)} ${capName}${reset}`,
  };
}

const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000, g: 1_000_000_000 };

export class TokenBudgetError extends Error {
  readonly code = "TOKEN_BUDGET";
  constructor(message: string) {
    super(message);
    this.name = "TokenBudgetError";
  }
}

export type ParsedProviderWindows = Partial<Record<TokenWindow, number>>;
export type ParsedTokenBudget = Partial<Record<BilledProvider, ParsedProviderWindows>>;

export interface TokenWindowUse {
  scale: TokenWindow;
  used: number;
  cap: number;
  remaining: number;
  /** When the oldest billed run in this window ages out. Null if nothing used. */
  resets_at: string | null;
}

export interface ProviderBudgetReport {
  windows: TokenWindowUse[];
  unmetered: boolean;
}

export interface TokenBudgetReport {
  providers: Partial<Record<BilledProvider, ProviderBudgetReport>>;
  how_to: string;
  tightest: TokenWindowUse & { provider: BilledProvider } | null;
}

export interface TokenBudgetVerdict {
  skip: boolean;
  reason?: string;
  report: TokenBudgetReport;
}

export const TOKEN_BUDGET_HOW_TO =
  "To cap billed extract, add to config.json in this store's data directory:\n" +
  '"intelligence": { "token_budget": { "cli": { "week": "10M" } } }\n' +
  "hour, day, week, and month are rolling. Omit a scale to leave it unlimited. " +
  "Then run consolidate as usual.";

export const TOKEN_BUDGET_HOW_TO_SET =
  "Edit token_budget in this store's config.json.";

export function isBilledProvider(value: string): value is BilledProvider {
  return (BILLED_PROVIDERS as readonly string[]).includes(value);
}

export function parseTokenCount(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new TokenBudgetError(tokenBudgetInvalidMessage(value));
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new TokenBudgetError(tokenBudgetInvalidMessage(value));
  }
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?\s*(b|kb|mb|gb|tb)$/i.test(trimmed)) {
    throw new TokenBudgetError(
      `Invalid intelligence.token_budget ${JSON.stringify(value)}. ` +
        `Token caps use k/M/G (thousands of tokens), not disk units.`,
    );
  }
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kmg])?$/i);
  if (!m) throw new TokenBudgetError(tokenBudgetInvalidMessage(value));
  const n = Number(m[1]);
  const mul = m[2] ? SUFFIX[m[2].toLowerCase()]! : 1;
  const tokens = Math.round(n * mul);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new TokenBudgetError(tokenBudgetInvalidMessage(value));
  }
  return tokens;
}

export function tokenBudgetInvalidMessage(value: unknown): string {
  return (
    `Invalid intelligence.token_budget ${JSON.stringify(value)}. ` +
    `Use an object like { "cli": { "week": "10M" } }, or omit it for unlimited.`
  );
}

export function parseTokenBudget(value: unknown): ParsedTokenBudget | null {
  if (value == null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TokenBudgetError(tokenBudgetInvalidMessage(value));
  }
  const raw = value as Record<string, unknown>;
  const out: ParsedTokenBudget = {};
  for (const [key, body] of Object.entries(raw)) {
    if (key === "http") continue;
    if (!isBilledProvider(key)) {
      throw new TokenBudgetError(tokenBudgetInvalidMessage(value));
    }
    if (body == null || body === "") continue;
    if (typeof body !== "object" || Array.isArray(body)) {
      throw new TokenBudgetError(tokenBudgetInvalidMessage(value));
    }
    const windows: ParsedProviderWindows = {};
    for (const [scale, count] of Object.entries(body as Record<string, unknown>)) {
      if (!(TOKEN_WINDOWS as readonly string[]).includes(scale)) {
        throw new TokenBudgetError(tokenBudgetInvalidMessage(value));
      }
      if (count == null || count === "") continue;
      windows[scale as TokenWindow] = parseTokenCount(count);
    }
    if (Object.keys(windows).length > 0) out[key] = windows;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000 && n % 1_000_000_000 === 0) return `${n / 1_000_000_000}G`;
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function tokensOfProvider(
  run: StoredIntelligenceRun,
  provider: BilledProvider,
): { tokens: number; unmetered: boolean; billed: boolean } {
  let tokens = 0;
  let unmetered = false;
  let billed = false;
  for (const stage of Object.values(run.usage.stages)) {
    if (stage.provider !== provider) continue;
    billed = true;
    if (stage.calls >= 1 && stage.input_tokens == null && stage.output_tokens == null) {
      unmetered = true;
    }
    tokens += (stage.input_tokens ?? 0) + (stage.output_tokens ?? 0);
  }
  return { tokens, unmetered, billed };
}

export function longestWindowMs(windows: ParsedProviderWindows): number {
  let max = 0;
  for (const scale of TOKEN_WINDOWS) {
    if (windows[scale] != null) max = Math.max(max, TOKEN_WINDOW_MS[scale]);
  }
  return max;
}

export function evaluateTokenBudget(
  runs: StoredIntelligenceRun[],
  budget: ParsedTokenBudget | null,
  now = new Date(),
): TokenBudgetReport {
  const providers: TokenBudgetReport["providers"] = {};
  let tightest: TokenBudgetReport["tightest"] = null;
  let tightestRatio = Number.POSITIVE_INFINITY;
  if (budget) {
    const nowMs = now.getTime();
    for (const provider of BILLED_PROVIDERS) {
      const windows = budget[provider];
      if (!windows) continue;
      let unmetered = false;
      const uses: TokenWindowUse[] = [];
      for (const scale of TOKEN_WINDOWS) {
        const cap = windows[scale];
        if (cap == null) continue;
        const cutoff = new Date(nowMs - TOKEN_WINDOW_MS[scale]).toISOString();
        let used = 0;
        let oldest: string | null = null;
        for (const run of runs) {
          if (run.created_at < cutoff) continue;
          const part = tokensOfProvider(run, provider);
          if (!part.billed) continue;
          if (part.unmetered) unmetered = true;
          used += part.tokens;
          if (part.tokens > 0 && (!oldest || run.created_at < oldest)) {
            oldest = run.created_at;
          }
        }
        const remaining = Math.max(0, cap - used);
        const resets_at = oldest
          ? new Date(Date.parse(oldest) + TOKEN_WINDOW_MS[scale]).toISOString()
          : null;
        const row: TokenWindowUse = { scale, used, cap, remaining, resets_at };
        uses.push(row);
        const ratio = cap > 0 ? remaining / cap : 0;
        if (ratio < tightestRatio) {
          tightestRatio = ratio;
          tightest = { ...row, provider };
        }
      }
      if (uses.length) providers[provider] = { windows: uses, unmetered };
    }
  }
  const anyCap = Object.keys(providers).length > 0;
  return {
    providers,
    how_to: anyCap ? TOKEN_BUDGET_HOW_TO_SET : TOKEN_BUDGET_HOW_TO,
    tightest,
  };
}

export function verdictForProvider(
  report: TokenBudgetReport,
  provider: string,
): TokenBudgetVerdict {
  if (!isBilledProvider(provider)) {
    return { skip: false, report };
  }
  const slice = report.providers[provider];
  if (!slice) return { skip: false, report };
  if (slice.unmetered) {
    return {
      skip: true,
      reason: tokenBudgetUnmeteredMessage(provider),
      report,
    };
  }
  for (const w of slice.windows) {
    if (w.used >= w.cap) {
      return {
        skip: true,
        reason: tokenBudgetRefusedMessage({
          provider,
          scale: w.scale,
          used: w.used,
          cap: w.cap,
        }),
        report,
      };
    }
  }
  return { skip: false, report };
}

export function tokenBudgetRefusedMessage(opts: {
  provider: string;
  scale: TokenWindow;
  used: number;
  cap: number;
}): string {
  const name = billedProviderName(opts.provider);
  return (
    `Billed ${name} extract is at its token budget ` +
    `(${formatTokenCount(opts.used)} of ${formatTokenCount(opts.cap)} in the ` +
    `${TOKEN_WINDOW_LABEL[opts.scale]}). Chat was not examined and the ` +
    `watermark was held. Raise or unset intelligence.token_budget, or wait ` +
    `for the window to age.`
  );
}

export function tokenBudgetUnmeteredMessage(provider: string): string {
  const name = billedProviderName(provider);
  return (
    `Billed ${name} extract ran without reporting tokens, so the budget ` +
    `cannot be trusted. Further ${name} extract is skipped until usage ` +
    `envelopes appear or you unset intelligence.token_budget.`
  );
}

export function parseIntelligenceTokenBudget(
  intelligence: IntelligenceConfig | undefined,
): ParsedTokenBudget | null {
  return parseTokenBudget(intelligence?.token_budget);
}

export function bindTokenBudget(db: Db, budget: ParsedTokenBudget | null): void {
  if (budget) bound.set(db, budget);
  else bound.delete(db);
}

export function getBoundTokenBudget(db: Db): ParsedTokenBudget | null {
  return bound.get(db) ?? null;
}

export async function loadRunsForBudget(
  listSince: (sinceIso: string) => Promise<StoredIntelligenceRun[]>,
  budget: ParsedTokenBudget | null,
  now = new Date(),
): Promise<StoredIntelligenceRun[]> {
  if (!budget) return [];
  let maxMs = 0;
  for (const windows of Object.values(budget)) {
    if (!windows) continue;
    maxMs = Math.max(maxMs, longestWindowMs(windows));
  }
  if (maxMs === 0) return [];
  const since = new Date(now.getTime() - maxMs).toISOString();
  return listSince(since);
}
