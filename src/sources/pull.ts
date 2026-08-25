/**
 * Pull named capture sources into session_events.
 *
 * This is the single entry for client-agnostic capture. `openmemory pull`
 * is the documented command; the MCP server calls the same function once
 * when a session starts so a long-lived process with sources configured
 * does not need a separate invocation. Empty `sources` is a successful
 * no-op — pull is off.
 */

import type { Db } from "../db/connection.js";
import {
  discoverClaudeCodeFiles,
  ingestClaudeCodeFile,
} from "./claude-code.js";
import { resolveSources } from "./resolve.js";

export interface PullResult {
  /** How many configured sources were resolved and walked. */
  sources: number;
  /** Transcript files discovered across those sources. */
  files: number;
  /** New session_events inserted this run. */
  events_inserted: number;
  /** Complete lines that could not be mapped honestly (system/meta/empty). */
  events_skipped: number;
}

/**
 * A first pull of a whole Claude home can insert thousands of events.
 * Flushing those at session_start would spawn `claude -p` on the lot.
 * Incremental pulls of a handful of new lines still match session_start
 * intent and may run extract-then-graduate. Zero inserts keep leftover
 * recovery (scheduler.full()).
 */
export const SESSION_START_FLUSH_MAX_INSERTED = 50;

/** Whether session_start should call scheduler.full() after this pull. */
export function shouldFlushAfterSessionStartPull(
  eventsInserted: number,
  threshold: number = SESSION_START_FLUSH_MAX_INSERTED,
): boolean {
  return eventsInserted <= threshold;
}

/**
 * Whether the CLI pull should wake a running server with `tick`.
 *
 * Same band as session_start: a handful of new lines may extract
 * (threshold permitting). A first-run backfill above the cap must not.
 * Zero inserts send nothing — leftovers are session_start's job.
 *
 * `tick` is D→I, not I→K: it honours the consolidation threshold so a Stop
 * hook that pulls every turn does not spawn `claude -p` on every reply.
 * A pull with no server listening cannot tick; the CLI then tells the
 * user to run `openmemory consolidate`.
 */
export function shouldTickAfterCliPull(
  eventsInserted: number,
  threshold: number = SESSION_START_FLUSH_MAX_INSERTED,
): boolean {
  return eventsInserted > 0 && eventsInserted <= threshold;
}

/**
 * Resolve `config.sources` and ingest every new transcript line.
 *
 * Throws on an unknown kind or a malformed source — a typo must not look
 * like "nothing to pull". An empty list returns zeros and inserts nothing.
 */
export function pullSources(db: Db, sources: unknown): PullResult {
  const resolved = resolveSources(sources);
  const result: PullResult = {
    sources: resolved.length,
    files: 0,
    events_inserted: 0,
    events_skipped: 0,
  };

  for (const source of resolved) {
    const files = discoverClaudeCodeFiles(source);
    result.files += files.length;
    for (const file of files) {
      const fileResult = ingestClaudeCodeFile(db, file);
      result.events_inserted += fileResult.inserted;
      result.events_skipped += fileResult.skipped;
    }
  }

  return result;
}
