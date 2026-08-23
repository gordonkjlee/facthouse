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
