/**
 * Copy named capture sources into session_events — the copy step.
 *
 * This is the single entry for client-agnostic capture. `factmem consolidate`
 * runs it as its first step; the MCP server calls the same function at
 * session start and, on a named-source store, again at the start of a
 * tool or resource read when the files have grown. Empty `sources` is a
 * successful no-op — copy is off, and the heartbeat never walks a client
 * home.
 */

import type { CaptureSourceKind } from "../types/config.js";
import type { Db } from "../db/connection.js";
import { storeHasNamedSources } from "../tools/capture-fact-description.js";
import {
  discoverClaudeCodeFiles,
  copyClaudeCodeFile,
} from "./claude-code.js";
import { discoverCursorFiles, copyCursorFile } from "./cursor.js";
import type { JsonlFileCopy } from "./jsonl-copy.js";
import { resolveSources, type ResolvedCaptureSource } from "./resolve.js";

export interface CopyResult {
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
  copy: (db: Db, filePath: string) => Promise<JsonlFileCopy>;
}

const adapters: Record<CaptureSourceKind, SourceAdapter> = {
  "claude-code": {
    discover: discoverClaudeCodeFiles,
    copy: copyClaudeCodeFile,
  },
  cursor: {
    discover: discoverCursorFiles,
    copy: copyCursorFile,
  },
};

/** In-process throttle for MCP-call tails. Not a product timer. */
export const COPY_HEARTBEAT_DEBOUNCE_MS = 2000;

const EMPTY_COPY: CopyResult = {
  sources: 0,
  files: 0,
  events_inserted: 0,
  events_skipped: 0,
};

export interface CopyHeartbeat {
  /** Copy new JSONL lines if files grew. Never extracts. */
  /**
   * Copy new JSONL lines if files grew. Never extracts. `force` skips the
   * debounce (still coalesces an in-flight walk): the copy step of a
   * consolidate must see the newest lines, not the last call's snapshot.
   */
  copyIfGrown(opts?: { force?: boolean }): Promise<CopyResult>;
}

export interface CopyHeartbeatOpts {
  db: Db;
  sources: unknown;
  debounceMs?: number;
  now?: () => number;
  /** Override for tests. Production uses `copySources`. */
  copy?: (db: Db, sources: unknown) => Promise<CopyResult>;
  onCopied?: (result: CopyResult) => void;
  onError?: (err: Error) => void;
}

/**
 * In-process JSONL tail for a live MCP server. Empty `sources` never
 * discovers files (so a record store does not open `~/.claude`). A burst
 * of tool calls in one turn shares one walk.
 */
export function createCopyHeartbeat(opts: CopyHeartbeatOpts): CopyHeartbeat {
  const debounceMs = opts.debounceMs ?? COPY_HEARTBEAT_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  const copy = opts.copy ?? copySources;
  let lastWalkAt: number | null = null;
  let inFlight: Promise<CopyResult> | null = null;

  return {
    async copyIfGrown(call: { force?: boolean } = {}): Promise<CopyResult> {
      if (!storeHasNamedSources(opts.sources)) {
        return { ...EMPTY_COPY };
      }
      if (inFlight) return inFlight;
      const t = now();
      if (!call.force && lastWalkAt !== null && t - lastWalkAt < debounceMs) {
        return { ...EMPTY_COPY };
      }
      inFlight = (async () => {
        try {
          const result = await copy(opts.db, opts.sources);
          if (result.events_inserted > 0) opts.onCopied?.(result);
          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          opts.onError?.(error);
          return { ...EMPTY_COPY };
        } finally {
          // Stamp after the walk so a slow copy does not expire the
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
 * Resolve `config.sources` and copy every new transcript line.
 *
 * Throws on an unknown kind or a malformed source — a typo must not look
 * like "nothing to copy". An empty list returns zeros and inserts nothing.
 */
export async function copySources(db: Db, sources: unknown): Promise<CopyResult> {
  const resolved = resolveSources(sources);
  const result: CopyResult = {
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
      const fileResult = await adapter.copy(db, file);
      result.events_inserted += fileResult.inserted;
      result.events_skipped += fileResult.skipped;
    }
  }

  return result;
}
