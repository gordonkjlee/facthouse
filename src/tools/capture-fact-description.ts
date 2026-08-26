/**
 * One definition of the capture_fact tool description.
 *
 * A store with named `sources` already ingests conversations; the assistant
 * should not be told to recapture every fact. Empty `sources` is the other
 * product: capture_fact is how knowledge gets in. Those two instructions used
 * to live as a hardcoded proactive string in the tool and a correction story
 * in the README, and they already disagreed.
 *
 * What a durable fact *is* lives in extract-prompt.ts (DURABLE_FACT) so extract
 * and capture cannot disagree. The leads here only say when to call.
 */

import { DURABLE_FACT } from "../intelligence/extract-prompt.js";

/** Named sources mean pull is on. Malformed entries still count: the user
 *  intended a pull store. Empty / omitted is proactive capture. */
export function storeHasNamedSources(sources: unknown): boolean {
  return Array.isArray(sources) && sources.length > 0;
}

const PROACTIVE_LEAD =
  "Store a durable fact worth remembering across sessions. " +
  DURABLE_FACT +
  " Call this proactively whenever you learn something this store should keep.";

const CORRECTION_LEAD =
  "Store a durable fact that pull-plus-extraction missed, or a judgement that is not in the transcript. " +
  DURABLE_FACT +
  " Named sources already ingest conversations — do not recapture what the user just said. " +
  "Call this when you need to correct the knowledge, rather than whenever you learn something.";

const FAST =
  "Capture is fast — the server stores the fact immediately. Entity extraction, " +
  "domain classification, and cross-session reconciliation run in batch when " +
  "you call consolidate.";

const FREQUENTLY = "Capture frequently without slowing the conversation.";

const DEDUP =
  "Exact same-session duplicates are dropped immediately. Cross-session exact " +
  "duplicates are also rejected during the next consolidation run — safe to " +
  "capture the same fact from multiple conversations without polluting the " +
  "knowledge graph.";

/** Tool description an assistant actually reads. Driven by this store's sources. */
export function captureFactDescription(sources: unknown): string {
  if (storeHasNamedSources(sources)) {
    return [CORRECTION_LEAD, FAST, DEDUP].join("\n\n");
  }
  return [PROACTIVE_LEAD, `${FAST} ${FREQUENTLY}`, DEDUP].join("\n\n");
}
