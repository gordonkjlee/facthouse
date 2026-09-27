/**
 * One definition of billed intelligence spend.
 *
 * Tokens are provider-reported (input + output + cache fields). Envelope USD
 * is discarded. Missing token keys stay absent — never stored as zero, which
 * would look like a free successful extract.
 *
 * Shared by the CLI subprocess parser, the sampling path, persistence, and
 * `get_stats` / `facthouse stats` so those surfaces cannot disagree.
 */

export const INTELLIGENCE_STATS_LAST_N = 10;

export type IntelligenceRunKind = "consolidate" | "capture";

export interface StageUsage {
  provider: string;
  model?: string;
  calls: number;
  input_tokens?: number;
  output_tokens?: number;
  elapsed_ms: number;
}

export interface IntelligenceUsage {
  calls: number;
  input_tokens?: number;
  output_tokens?: number;
  elapsed_ms: number;
  stages: Record<string, StageUsage>;
}

export interface IntelligenceSpendRollup {
  calls: number;
  input_tokens?: number;
  output_tokens?: number;
  elapsed_ms: number;
  by_stage: Record<string, Omit<StageUsage, "provider" | "model">>;
  by_provider: Record<string, Omit<StageUsage, "provider" | "model">>;
}

export interface IntelligenceRunSummary {
  id: string;
  kind: IntelligenceRunKind;
  created_at: string;
  consolidation_id: string | null;
  calls: number;
  input_tokens?: number;
  output_tokens?: number;
  elapsed_ms: number;
  stages: Record<string, StageUsage>;
  trigger?: string | null;
  source_tool?: string | null;
  project?: string | null;
}

export interface IntelligenceSpendStats {
  last_24h: IntelligenceSpendRollup;
  all_time: IntelligenceSpendRollup;
  recent: IntelligenceRunSummary[];
}

export interface StoredIntelligenceRun {
  id: string;
  kind: IntelligenceRunKind;
  consolidation_id: string | null;
  created_at: string;
  usage: IntelligenceUsage;
  trigger?: string | null;
  source_tool?: string | null;
  project?: string | null;
}

const STAGE_ALIASES: Record<string, string> = {
  "stage-1-extract": "extract",
  "stage-2-reconcile": "reconcile",
  "stage-3-supersede": "supersede",
  "stage-4-summarise": "summarise",
  "stage-classify": "classify",
  "stage-entities": "entities",
};

export function canonicalStage(stageName: string): string {
  if (STAGE_ALIASES[stageName]) return STAGE_ALIASES[stageName];
  return stageName.replace(/^stage-\d+-/, "").replace(/^stage-/, "");
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Sum optional counts. Both absent → absent (not zero). */
export function addOptional(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Map a CLI result envelope's `usage` object (`stream-json` type:result, or a json envelope).
 * Cache-creation and cache-read tokens are billed/quota'd, so they fold into
 * input. `total_cost_usd` is ignored.
 */
export function parseEnvelopeUsage(
  envelope: Record<string, unknown> | null | undefined,
): { input_tokens?: number; output_tokens?: number } {
  if (!envelope || typeof envelope.usage !== "object" || envelope.usage == null) {
    return {};
  }
  const usage = envelope.usage as Record<string, unknown>;
  const input = addOptional(
    asFiniteNumber(usage.input_tokens),
    addOptional(
      asFiniteNumber(usage.cache_creation_input_tokens),
      asFiniteNumber(usage.cache_read_input_tokens),
    ),
  );
  const output = asFiniteNumber(usage.output_tokens);
  return {
    ...(input != null ? { input_tokens: input } : {}),
    ...(output != null ? { output_tokens: output } : {}),
  };
}

export class UsageAccumulator {
  private readonly stages = new Map<string, StageUsage>();

  constructor(private readonly defaults: { provider: string; model?: string }) {}

  record(
    stageName: string,
    call: {
      provider?: string;
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      elapsed_ms: number;
    },
  ): void {
    const stage = canonicalStage(stageName);
    const provider = call.provider ?? this.defaults.provider;
    const model = call.model ?? this.defaults.model;
    const prev = this.stages.get(stage);
    const next: StageUsage = {
      provider,
      calls: (prev?.calls ?? 0) + 1,
      elapsed_ms: (prev?.elapsed_ms ?? 0) + Math.max(0, call.elapsed_ms),
    };
    if (model) next.model = model;
    const input = addOptional(prev?.input_tokens, call.input_tokens);
    const output = addOptional(prev?.output_tokens, call.output_tokens);
    if (input != null) next.input_tokens = input;
    if (output != null) next.output_tokens = output;
    this.stages.set(stage, next);
  }

  snapshot(): IntelligenceUsage {
    const stages: Record<string, StageUsage> = {};
    let calls = 0;
    let elapsed = 0;
    let input: number | undefined;
    let output: number | undefined;
    for (const [name, stage] of this.stages) {
      stages[name] = { ...stage };
      calls += stage.calls;
      elapsed += stage.elapsed_ms;
      input = addOptional(input, stage.input_tokens);
      output = addOptional(output, stage.output_tokens);
    }
    const usage: IntelligenceUsage = { calls, elapsed_ms: elapsed, stages };
    if (input != null) usage.input_tokens = input;
    if (output != null) usage.output_tokens = output;
    return usage;
  }

  /** Drain recorded usage. Null when nothing was billed (no fake zeros). */
  take(): IntelligenceUsage | null {
    const snap = this.snapshot();
    this.stages.clear();
    return snap.calls >= 1 ? snap : null;
  }
}

export function emptySpendRollup(): IntelligenceSpendRollup {
  return {
    calls: 0,
    elapsed_ms: 0,
    by_stage: {},
    by_provider: {},
  };
}

export function emptySpendStats(): IntelligenceSpendStats {
  return {
    last_24h: emptySpendRollup(),
    all_time: emptySpendRollup(),
    recent: [],
  };
}

function createdAtMs(value: string): number {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function addToBucket(
  buckets: Record<string, Omit<StageUsage, "provider" | "model">>,
  key: string,
  stage: Pick<StageUsage, "calls" | "input_tokens" | "output_tokens" | "elapsed_ms">,
): void {
  const prev = buckets[key];
  const next: Omit<StageUsage, "provider" | "model"> = {
    calls: (prev?.calls ?? 0) + stage.calls,
    elapsed_ms: (prev?.elapsed_ms ?? 0) + stage.elapsed_ms,
  };
  const input = addOptional(prev?.input_tokens, stage.input_tokens);
  const output = addOptional(prev?.output_tokens, stage.output_tokens);
  if (input != null) next.input_tokens = input;
  if (output != null) next.output_tokens = output;
  buckets[key] = next;
}

function rollupOf(runs: StoredIntelligenceRun[]): IntelligenceSpendRollup {
  const out = emptySpendRollup();
  for (const run of runs) {
    out.calls += run.usage.calls;
    out.elapsed_ms += run.usage.elapsed_ms;
    out.input_tokens = addOptional(out.input_tokens, run.usage.input_tokens);
    out.output_tokens = addOptional(out.output_tokens, run.usage.output_tokens);
    for (const [name, stage] of Object.entries(run.usage.stages)) {
      addToBucket(out.by_stage, name, stage);
      addToBucket(out.by_provider, stage.provider, stage);
    }
  }
  return out;
}

function asSummary(run: StoredIntelligenceRun): IntelligenceRunSummary {
  const summary: IntelligenceRunSummary = {
    id: run.id,
    kind: run.kind,
    created_at: run.created_at,
    consolidation_id: run.consolidation_id,
    calls: run.usage.calls,
    elapsed_ms: run.usage.elapsed_ms,
    stages: run.usage.stages,
    trigger: run.trigger ?? null,
    source_tool: run.source_tool ?? null,
    project: run.project ?? null,
  };
  if (run.usage.input_tokens != null) summary.input_tokens = run.usage.input_tokens;
  if (run.usage.output_tokens != null) summary.output_tokens = run.usage.output_tokens;
  return summary;
}

/** Roll stored runs into the stats shape. `nowMs` is injectable for tests. */
export function rollupRuns(
  runs: StoredIntelligenceRun[],
  nowMs: number = Date.now(),
  lastN: number = INTELLIGENCE_STATS_LAST_N,
): IntelligenceSpendStats {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  const newestFirst = [...runs].sort((a, b) => {
    const byTime = createdAtMs(b.created_at) - createdAtMs(a.created_at);
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  });
  const last24h = newestFirst.filter((r) => createdAtMs(r.created_at) >= cutoff);
  return {
    last_24h: rollupOf(last24h),
    all_time: rollupOf(newestFirst),
    recent: newestFirst.slice(0, lastN).map(asSummary),
  };
}

export function parseStoredUsage(raw: string): IntelligenceUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.calls !== "number" || typeof obj.elapsed_ms !== "number") return null;
  if (!obj.stages || typeof obj.stages !== "object") return null;
  const stages: Record<string, StageUsage> = {};
  for (const [name, value] of Object.entries(obj.stages as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const s = value as Record<string, unknown>;
    if (typeof s.provider !== "string" || typeof s.calls !== "number") continue;
    const stage: StageUsage = {
      provider: s.provider,
      calls: s.calls,
      elapsed_ms: typeof s.elapsed_ms === "number" ? s.elapsed_ms : 0,
    };
    if (typeof s.model === "string") stage.model = s.model;
    if (typeof s.input_tokens === "number") stage.input_tokens = s.input_tokens;
    if (typeof s.output_tokens === "number") stage.output_tokens = s.output_tokens;
    stages[name] = stage;
  }
  const usage: IntelligenceUsage = {
    calls: obj.calls,
    elapsed_ms: obj.elapsed_ms,
    stages,
  };
  if (typeof obj.input_tokens === "number") usage.input_tokens = obj.input_tokens;
  if (typeof obj.output_tokens === "number") usage.output_tokens = obj.output_tokens;
  return usage;
}

export interface UsageTaking {
  takeUsage?(): IntelligenceUsage | null;
}

export function takeProviderUsage(provider: UsageTaking): IntelligenceUsage | null {
  return provider.takeUsage?.() ?? null;
}
