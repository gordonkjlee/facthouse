/**
 * Cursor Agent JSONL adapter.
 *
 * Read-only. Discovers transcript files under a configured `home` — the
 * Cursor config dir (`~/.cursor`) — and maps each line onto session_events.
 * Never writes, deletes, or rewrites anything under `home`.
 *
 * Layouts observed in the wild (both supported):
 *   home/projects/<group>/agent-transcripts/<session-id>.jsonl
 *   home/projects/<group>/agent-transcripts/<session-id>/<session-id>.jsonl
 *
 * This is the JSONL export only. Composer `store.db`, `state.vscdb`,
 * `chats/`, and legacy `.txt` transcripts are not walked — those are a
 * different product, not a second parser on this path. `subagents/` nests
 * are skipped. Nothing outside projects/<group>/agent-transcripts/ is walked.
 *
 * Cursor's JSONL has no timestamp and no tool results. `occurred_at` stays
 * null rather than copying copy time; missing tool output is not invented.
 *
 * Optional `cwd` restricts discovery to that project's group. Cursor encodes
 * `C:\dev\app` as `c-dev-app` (not Claude Code's `C--dev-app`). A cwd that
 * is already a single path segment (the on-disk group, including opaque
 * numeric ids) is honoured as a literal name. Do not pass an absolute path
 * as a child of `projects/` — that would escape the home.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/connection.js";
import { mapTranscriptLine } from "./claude-code.js";
import {
  copyJsonlFile,
  isDir,
  listJsonl,
  type JsonlFileCopy,
} from "./jsonl-copy.js";
import { encodeCursorProjectDir, type ResolvedCaptureSource } from "./resolve.js";

const SKIP_NEST_DIRS = new Set(["subagents"]);

/**
 * Discover Cursor Agent JSONL files for one configured home.
 * Returns absolute paths, sorted, so tests (and watermarks) are stable.
 */
export function discoverCursorFiles(source: ResolvedCaptureSource): string[] {
  const projectsRoot = path.join(source.home, "projects");
  if (!isDir(projectsRoot)) return [];

  const groups = listCursorProjectGroups(projectsRoot, source.cwd);
  const files: string[] = [];
  for (const group of groups) {
    const transcripts = path.join(group, "agent-transcripts");
    if (!isDir(transcripts)) continue;
    files.push(...listJsonl(transcripts));
    for (const entry of readdirSync(transcripts, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_NEST_DIRS.has(entry.name)) continue;
      files.push(...listJsonl(path.join(transcripts, entry.name)));
    }
  }
  return [...new Set(files)].sort();
}

/** Tail one Cursor Agent JSONL file into session_events. */
export async function copyCursorFile(db: Db, filePath: string): Promise<JsonlFileCopy> {
  return await copyJsonlFile(db, filePath, {
    sourceTool: "cursor",
    mapLine: mapTranscriptLine,
  });
}

/**
 * Candidate on-disk group names for a configured cwd.
 *
 * Absolute paths and names containing separators are encoded, never joined
 * as children of `projects/` (on Windows `path.join(root, "C:\\dev\\app")`
 * is `C:\dev\app` — outside the configured home).
 */
export function cursorGroupNames(cwd: string): string[] {
  const encoded = encodeCursorProjectDir(cwd);
  const names = encoded ? [encoded] : [];
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (trimmed && !/[\\/]/.test(trimmed) && trimmed !== encoded) {
    names.push(trimmed);
  }
  return names;
}

function listCursorProjectGroups(projectsRoot: string, cwd?: string): string[] {
  if (cwd) {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const name of cursorGroupNames(cwd)) {
      const candidate = path.join(projectsRoot, name);
      if (seen.has(candidate) || !isDir(candidate)) continue;
      // Refuse a join that escaped projectsRoot (absolute cwd segment).
      const rel = path.relative(projectsRoot, candidate);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      seen.add(candidate);
      dirs.push(candidate);
    }
    return dirs;
  }
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name));
}
