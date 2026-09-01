/**
 * After a TTY copy init: offer pull, then consolidate if anything is unextracted.
 *
 * Not --yes, not record, not --web. Does not start the MCP server.
 * Pull copies D only (no tick). Consolidate is the slow CLI extract+graduate.
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

export interface InitBackfillDeps {
  pull: (dataDir: string) => Promise<{ events_inserted: number }>;
  unextracted: (dataDir: string) => Promise<number>;
  consolidate: (dataDir: string) => Promise<void>;
  providerIsHeuristic: boolean;
}

export async function offerInitBackfill(
  io: InitIo,
  dataDir: string,
  deps: InitBackfillDeps,
): Promise<void> {
  let copy = yesNo(await io.question(INIT_PROMPTS.copyNow), "yes");
  while (copy === "retry") {
    copy = yesNo(await io.question(INIT_PROMPTS.copyNow), "yes");
  }
  if (copy !== "yes") return;

  let inserted = 0;
  try {
    inserted = (await deps.pull(dataDir)).events_inserted;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.write(message);
    return;
  }
  io.write(INIT_PROMPTS.copiedEvents(inserted));
  if (inserted === 0) return;

  const pending = await deps.unextracted(dataDir);
  if (pending <= 0) return;
  if (deps.providerIsHeuristic) {
    io.write(INIT_PROMPTS.extractSkippedHeuristic);
    return;
  }

  let extract = yesNo(await io.question(INIT_PROMPTS.extractNow), "yes");
  while (extract === "retry") {
    extract = yesNo(await io.question(INIT_PROMPTS.extractNow), "yes");
  }
  if (extract !== "yes") return;

  try {
    await deps.consolidate(dataDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.write(message);
  }
}
