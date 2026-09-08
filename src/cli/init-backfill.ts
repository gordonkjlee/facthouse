/**
 * After a copy init that can still ask on stdin: offer copy, then extract +
 * integrate. TTY wizard, or `--web` once the page has closed if stdin is a
 * TTY. Not --yes, not record, not a loopback POST. Does not start the MCP
 * server. Copy fills D only (no model). Extract and integrate spend model
 * calls.
 */

import { storeHasNamedSources } from "../tools/capture-fact-description.js";
import { HISTORIC_CONFIRM_LINES } from "../intelligence/steps.js";
import type { HistoricSelection } from "../intelligence/historic-selection.js";
import { INIT_PROMPTS } from "./init-knobs.js";
import { yesNo, type InitIo } from "./init-wizard.js";
import { isConsolidateAbort } from "../intelligence/abort.js";

export function shouldOfferInitBackfill(opts: {
  ttyWalk: boolean;
  wroteConfig: boolean;
  sources: unknown;
}): boolean {
  return (
    opts.ttyWalk && opts.wroteConfig && storeHasNamedSources(opts.sources)
  );
}

/** TTY wizard, or `--web` after the page closes if stdin can still ask. */
export function stdinCanAskHistoric(opts: {
  usedTtyWizard: boolean;
  web: boolean;
  stdinIsTTY: boolean;
}): boolean {
  return opts.usedTtyWizard || (opts.web && opts.stdinIsTTY);
}

export type HistoricExtractChoice =
  | { kind: "skip" }
  | { kind: "all" }
  | { kind: "limit"; n: number }
  | { kind: "days"; days: number }
  | { kind: "retry" };

export function parseHistoricExtract(raw: string): HistoricExtractChoice {
  const token = raw.trim().toLowerCase();
  if (token === "" || token === "all") return { kind: "all" };
  if (token === "n" || token === "no") return { kind: "skip" };
  const days = /^([1-9]\d*)d$/.exec(token);
  if (days) return { kind: "days", days: Number(days[1]) };
  if (/^[1-9]\d*$/.test(token)) return { kind: "limit", n: Number.parseInt(token, 10) };
  return { kind: "retry" };
}

export function historicChoiceToken(choice: HistoricExtractChoice): string | null {
  if (choice.kind === "all") return "all";
  if (choice.kind === "days") return `${choice.days}d`;
  if (choice.kind === "limit") return String(choice.n);
  return null;
}

export interface InitBackfillConsolidateOpts {
  /** null = every remaining line; a number = oldest n. */
  extractLimit: number | null;
  /** When set, older lines are marked examined without a model call. */
  extractSince?: Date;
  progressTotal?: number;
  abort?: AbortSignal;
}

export interface InitBackfillConsolidateResult {
  factsIntegrated: number;
  eventsRemaining: number;
  skipped?: boolean;
  skipReason?: string;
  extractionDegraded?: boolean;
  prefixCommitted?: boolean;
  examinedThrough?: number;
  aborted?: boolean;
}

export interface InitBackfillResult {
  aborted: boolean;
}

export interface InitBackfillDeps {
  copy: (dataDir: string) => Promise<{ events_inserted: number }>;
  unextracted: (dataDir: string) => Promise<number>;
  selection: (
    dataDir: string,
    choice: Exclude<HistoricExtractChoice, { kind: "skip" | "retry" }>,
  ) => Promise<HistoricSelection>;
  consolidate: (
    dataDir: string,
    opts: InitBackfillConsolidateOpts,
  ) => Promise<InitBackfillConsolidateResult | undefined>;
  providerIsHeuristic: boolean;
  hasCursor?: boolean;
  abort?: AbortSignal;
}

function consolidateOpts(
  extract: Exclude<HistoricExtractChoice, { kind: "skip" | "retry" }>,
  chosenCount: number,
  abort?: AbortSignal,
): InitBackfillConsolidateOpts {
  const base = { progressTotal: chosenCount, abort };
  if (extract.kind === "all") return { ...base, extractLimit: null };
  if (extract.kind === "limit") return { ...base, extractLimit: extract.n };
  return {
    ...base,
    extractLimit: null,
    extractSince: new Date(Date.now() - extract.days * 24 * 60 * 60 * 1000),
  };
}

export async function offerInitBackfill(
  io: InitIo,
  dataDir: string,
  deps: InitBackfillDeps,
): Promise<InitBackfillResult> {
  const ask = (prompt: string) => io.question(prompt, { signal: deps.abort });
  try {
    let copyNow = yesNo(await ask(INIT_PROMPTS.historicCopy), "yes");
    while (copyNow === "retry") {
      copyNow = yesNo(await ask(INIT_PROMPTS.historicCopy), "yes");
    }
    if (copyNow !== "yes") return { aborted: false };

    io.write(INIT_PROMPTS.copyingNow);
    let inserted: number;
    try {
      inserted = (await deps.copy(dataDir)).events_inserted;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      io.write(message);
      return { aborted: false };
    }
    io.write(INIT_PROMPTS.copiedLines(inserted));
    if (inserted === 0) return { aborted: false };

    const pending = await deps.unextracted(dataDir);
    if (pending <= 0) return { aborted: false };
    if (deps.providerIsHeuristic) {
      io.write(INIT_PROMPTS.extractSkippedHeuristic);
      return { aborted: false };
    }

    const prompt = INIT_PROMPTS.historicExtract(pending, {
      hasCursor: deps.hasCursor,
    });
    let extract = parseHistoricExtract(await ask(prompt));
    while (extract.kind === "retry") {
      extract = parseHistoricExtract(await ask(prompt));
    }
    if (extract.kind === "skip") return { aborted: false };

    let selection = await deps.selection(dataDir, extract);
    while (selection.chosenCount >= HISTORIC_CONFIRM_LINES) {
      const token = historicChoiceToken(extract)!;
      const raw = await ask(
        INIT_PROMPTS.historicExtractConfirm(
          token,
          selection.chosenCount,
          selection.truncatedChars,
        ),
      );
      if (raw.trim() === "") continue;
      const next = parseHistoricExtract(raw);
      if (next.kind === "retry") continue;
      if (next.kind === "skip") return { aborted: false };
      const nextToken = historicChoiceToken(next);
      if (nextToken === token) break;
      extract = next;
      selection = await deps.selection(dataDir, extract);
    }

    io.write(INIT_PROMPTS.extractingNow(selection.chosenCount));
    try {
      const result = await deps.consolidate(
        dataDir,
        consolidateOpts(extract, selection.chosenCount, deps.abort),
      );
      if (result?.aborted) {
        io.write(INIT_PROMPTS.extractInterrupted(result.eventsRemaining));
        return { aborted: true };
      }
      if (result?.skipped && result.skipReason) {
        io.write(result.skipReason);
        return { aborted: false };
      }
      if (result?.extractionDegraded) {
        io.write(
          result.prefixCommitted
            ? INIT_PROMPTS.extractDegradedKept(result.examinedThrough ?? 0)
            : INIT_PROMPTS.extractDegradedHeld,
        );
        if (!result.prefixCommitted) return { aborted: false };
      }
      if (result) {
        io.write(INIT_PROMPTS.integrated(result.factsIntegrated, result.eventsRemaining));
      }
    } catch (err: unknown) {
      if (isConsolidateAbort(err)) {
        const remaining = await deps.unextracted(dataDir);
        io.write(INIT_PROMPTS.extractInterrupted(remaining));
        return { aborted: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      io.write(message);
    }
    return { aborted: false };
  } catch (err: unknown) {
    if (isConsolidateAbort(err) || (err instanceof Error && err.name === "AbortError")) {
      const remaining = await deps.unextracted(dataDir).catch(() => 0);
      io.write(INIT_PROMPTS.extractInterrupted(remaining));
      return { aborted: true };
    }
    throw err;
  }
}
