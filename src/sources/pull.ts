/**
 * Pull named capture sources into session_events.
 *
 * This is the single entry for client-agnostic capture. `factmem pull`
 * is the documented command; the MCP server calls the same function at
 * session start and, on a named-source store, again at the start of a
 * tool or resource read when the files have grown. Empty `sources` is a
 * successful no-op — pull is off, and the heartbeat never walks a client
 * home.
 */

import type { CaptureSourceKind } from "../types/config.js";
import type { Db } from "../db/connection.js";
import { storeHasNamedSources } from "../tools/capture-fact-description.js";
import {
  discoverClaudeCodeFiles,
  ingestClaudeCodeFile,
} from "./claude-code.js";
import { discoverCursorFiles, ingestCursorFile } from "./cursor.js";
import type { JsonlFilePull } from "./jsonl-ingest.js";
import { resolveSources, type ResolvedCaptureSource } from "./resolve.js";

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

interface SourceAdapter {
  discover: (source: ResolvedCaptureSource) => string[];
  ingest: (db: Db, filePath: string) => Promise<JsonlFilePull>;
}

const adapters: Record<CaptureSourceKind, SourceAdapter> = {
  "claude-code": {
    discover: discoverClaudeCodeFiles,
    ingest: ingestClaudeCodeFile,
  },
  cursor: {
    discover: discoverCursorFiles,
    ingest: ingestCursorFile,
  },
};

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
 * `tick` is D→I, not I→K: it honours the consolidation threshold so a
 * frequent incremental pull does not spawn `claude -p` on every reply.
 * A pull with no server listening cannot tick; the CLI then tells the
 * user to run `factmem consolidate`.
 */
export function shouldTickAfterCliPull(
  eventsInserted: number,
  threshold: number = SESSION_START_FLUSH_MAX_INSERTED,
): boolean {
  return eventsInserted > 0 && eventsInserted <= threshold;
}

/** In-process throttle for MCP-call tails. Not a product timer. */
export const PULL_HEARTBEAT_DEBOUNCE_MS = 2000;

export type PullFollowUp = "tick" | "flush" | "none";

/**
 * What the CLI does after copying D. `--flush` is compact wake-up
 * (graduate, not extract). `--no-tick` copies only. Default still ticks
 * a handful of new lines when a server is listening.
 */
export function pullFollowUp(opts: {
  flush: boolean;
  noTick: boolean;
  eventsInserted: number;
}): PullFollowUp {
  if (opts.flush) return "flush";
  if (opts.noTick) return "none";
  if (shouldTickAfterCliPull(opts.eventsInserted)) return "tick";
  return "none";
}

const EMPTY_PULL: PullResult = {
  sources: 0,
  files: 0,
  events_inserted: 0,
  events_skipped: 0,
};

export interface PullHeartbeat {
  /** Copy new JSONL lines if files grew. Never extracts. */
  pullIfGrown(): Promise<PullResult>;
}

export interface PullHeartbeatOpts {
  db: Db;
  sources: unknown;
  debounceMs?: number;
  now?: () => number;
  /** Override for tests. Production uses `pullSources`. */
  pull?: (db: Db, sources: unknown) => Promise<PullResult>;
  onPulled?: (result: PullResult) => void;
  onError?: (err: Error) => void;
}

/**
 * In-process JSONL tail for a live MCP server. Empty `sources` never
 * discovers files (so a record store does not open `~/.claude`). A burst
 * of tool calls in one turn shares one walk.
 */
export function createPullHeartbeat(opts: PullHeartbeatOpts): PullHeartbeat {
  const debounceMs = opts.debounceMs ?? PULL_HEARTBEAT_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  const pull = opts.pull ?? pullSources;
  let lastWalkAt: number | null = null;
  let inFlight: Promise<PullResult> | null = null;

  return {
    async pullIfGrown(): Promise<PullResult> {
      if (!storeHasNamedSources(opts.sources)) {
        return { ...EMPTY_PULL };
      }
      if (inFlight) return inFlight;
      const t = now();
      if (lastWalkAt !== null && t - lastWalkAt < debounceMs) {
        return { ...EMPTY_PULL };
      }
      inFlight = (async () => {
        try {
          const result = await pull(opts.db, opts.sources);
          if (result.events_inserted > 0) opts.onPulled?.(result);
          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          opts.onError?.(error);
          return { ...EMPTY_PULL };
        } finally {
          // Stamp after the walk so a slow ingest does not expire the
          // debounce before it has finished.
          lastWalkAt = now();
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}

/**
 * Resolve `config.sources` and ingest every new transcript line.
 *
 * Throws on an unknown kind or a malformed source — a typo must not look
 * like "nothing to pull". An empty list returns zeros and inserts nothing.
 */
export async function pullSources(db: Db, sources: unknown): Promise<PullResult> {
  const resolved = resolveSources(sources);
  const result: PullResult = {
    sources: resolved.length,
    files: 0,
    events_inserted: 0,
    events_skipped: 0,
  };

  for (const source of resolved) {
    const adapter = adapters[source.kind];
    const files = adapter.discover(source);
    result.files += files.length;
    for (const file of files) {
      const fileResult = await adapter.ingest(db, file);
      result.events_inserted += fileResult.inserted;
      result.events_skipped += fileResult.skipped;
    }
  }

  return result;
}
