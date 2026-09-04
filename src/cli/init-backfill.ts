/**
 * After a TTY copy init: offer copy, then extract + integrate.
 *
 * Not --yes, not record, not --web. Does not start the MCP server.
 * Copy fills D only (no model). Extract and integrate spend model calls.
 */

import { storeHasNamedSources } from "../tools/capture-fact-description.js";
import { INIT_PROMPTS } from "./init-knobs.js";
import { yesNo, type InitIo } from "./init-wizard.js";

export function shouldOfferInitBackfill(opts: {
  ttyWalk: boolean;
  wroteConfig: boolean;
  sources: unknown;
}): boolean {
  return (
    opts.ttyWalk && opts.wroteConfig && storeHasNamedSources(opts.sources)
  );
}

export type HistoricExtractChoice =
  | { kind: "skip" }
  | { kind: "all" }
  | { kind: "limit"; n: number }
  | { kind: "days"; days: number }
  | { kind: "retry" };

export function parseHistoricExtract(raw: string): HistoricExtractChoice {
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "all") return { kind: "all" };
  if (t === "n" || t === "no") return { kind: "skip" };
  const days = /^([1-9]\d*)d$/.exec(t);
  if (days) return { kind: "days", days: Number(days[1]) };
  if (/^[1-9]\d*$/.test(t)) return { kind: "limit", n: Number.parseInt(t, 10) };
  return { kind: "retry" };
}

export interface InitBackfillConsolidateOpts {
  /** null = every remaining line; a number = oldest n. */
  extractLimit: number | null;
  /** When set, older lines are marked examined without a model call. */
  extractSince?: Date;
}

export interface InitBackfillDeps {
  copy: (dataDir: string) => Promise<{ events_inserted: number }>;
  unextracted: (dataDir: string) => Promise<number>;
  consolidate: (
    dataDir: string,
    opts: InitBackfillConsolidateOpts,
  ) => Promise<{ factsIntegrated: number; eventsRemaining: number } | undefined>;
  providerIsHeuristic: boolean;
}

export async function offerInitBackfill(
  io: InitIo,
  dataDir: string,
  deps: InitBackfillDeps,
): Promise<void> {
  let copyNow = yesNo(await io.question(INIT_PROMPTS.historicCopy), "yes");
  while (copyNow === "retry") {
    copyNow = yesNo(await io.question(INIT_PROMPTS.historicCopy), "yes");
  }
  if (copyNow !== "yes") return;

  io.write(INIT_PROMPTS.copyingNow);
  let inserted: number;
  try {
    inserted = (await deps.copy(dataDir)).events_inserted;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.write(message);
    return;
  }
  io.write(INIT_PROMPTS.copiedLines(inserted));
  if (inserted === 0) return;

  const pending = await deps.unextracted(dataDir);
  if (pending <= 0) return;
  if (deps.providerIsHeuristic) {
    io.write(INIT_PROMPTS.extractSkippedHeuristic);
    return;
  }

  let extract = parseHistoricExtract(await io.question(INIT_PROMPTS.historicExtract));
  while (extract.kind === "retry") {
    extract = parseHistoricExtract(await io.question(INIT_PROMPTS.historicExtract));
  }
  if (extract.kind === "skip") return;

  const opts: InitBackfillConsolidateOpts =
    extract.kind === "all"
      ? { extractLimit: null }
      : extract.kind === "limit"
        ? { extractLimit: extract.n }
        : {
            extractLimit: null,
            extractSince: new Date(Date.now() - extract.days * 24 * 60 * 60 * 1000),
          };

  io.write(INIT_PROMPTS.extractingNow(pending));
  try {
    const result = await deps.consolidate(dataDir, opts);
    if (result) {
      io.write(INIT_PROMPTS.integrated(result.factsIntegrated, result.eventsRemaining));
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.write(message);
  }
}
