/**
 * Grok Build session adapter.
 *
 * Read-only. Discovers transcripts under a configured `home` — Grok's config
 * dir (`~/.grok`, or `GROK_HOME`) — and maps each line onto session_events.
 * Never writes, deletes, or rewrites anything under `home`.
 *
 * Layout:
 *   home/sessions/<group>/<session-id>/chat_history.jsonl
 *
 * `<group>` is the cwd URL-encoded (`C%3A%5Cdev%5Capp`). Only
 * `chat_history.jsonl` is copied: one line is one model-bound record.
 * `updates.jsonl` (the chunked restore stream), `events.jsonl`, the system
 * prompt, summaries and compaction files are not walked, and nothing outside
 * `sessions/` is.
 *
 * Sub-agent runs are sibling session directories named under a parent's
 * `subagents/<child-id>/`. They are agent-to-agent chatter, not the user's
 * conversation, so they are skipped — the same intent as Claude Code's
 * nested `subagents/*.jsonl`. A child can sit in a different group from its
 * parent (it ran in another cwd), so the child set is read from every group.
 *
 * Grok lines carry no timestamp. `occurred_at` stays null rather than copy
 * time; the file's mtime rides in metadata for the historic window, as on
 * Cursor.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/connection.js";
import type { NewSessionEvent } from "../db/sessions.js";
import { SOURCE_MTIME_META } from "../intelligence/line-time.js";
import { copyJsonlFile, isDir, type JsonlFileCopy } from "./jsonl-copy.js";
import { encodeGrokSessionDir, type ResolvedCaptureSource } from "./resolve.js";

export const GROK_TRANSCRIPT = "chat_history.jsonl";

/** Grok falls back to a slug-plus-hash group past this many bytes. */
const MAX_GROUP_BYTES = 255;

/**
 * Discover Grok `chat_history.jsonl` files for one configured home.
 * Returns absolute paths, sorted, so tests (and watermarks) are stable.
 */
export function discoverGrokFiles(source: ResolvedCaptureSource): string[] {
  const sessionsRoot = path.join(source.home, "sessions");
  if (!isDir(sessionsRoot)) return [];

  const allGroups = listDirs(sessionsRoot);
  const children = childSessionIds(allGroups);
  const groups = source.cwd ? grokGroupsForCwd(sessionsRoot, source.cwd) : allGroups;

  const files: string[] = [];
  for (const group of groups) {
    for (const session of listDirs(group)) {
      if (children.has(path.basename(session))) continue;
      const file = path.join(session, GROK_TRANSCRIPT);
      if (isFile(file)) files.push(file);
    }
  }
  return [...new Set(files)].sort();
}

/** Tail one Grok `chat_history.jsonl` into session_events. */
export async function copyGrokFile(db: Db, filePath: string): Promise<JsonlFileCopy> {
  const abs = path.resolve(filePath);
  const sessionDir = path.dirname(abs);
  const sourceMtime = statSync(abs).mtime.toISOString();
  return await copyJsonlFile(db, abs, {
    sourceTool: "grok",
    sessionId: path.basename(sessionDir),
    project: path.basename(path.dirname(sessionDir)) || null,
    mapLine: (raw, sessionId, file, lineNumber, sourceTool) =>
      mapGrokLine(raw, sessionId, file, lineNumber, sourceTool).map((event) => ({
        ...event,
        metadata: { ...(event.metadata ?? {}), [SOURCE_MTIME_META]: sourceMtime },
      })),
  });
}

/**
 * Map one `chat_history.jsonl` line onto zero or more session_events.
 *
 * `user`, `assistant` (text and `tool_calls`), and `tool_result` are speech
 * or the record of a tool. `reasoning` (it carries `encrypted_content`),
 * `system`, `backend_tool_call`, and unknown types are skipped rather than
 * forced into a role. A `user` line with `synthetic_reason` was injected by
 * the harness (reminders, project instructions, compaction notes), not typed
 * by the person, and is skipped for the same reason.
 */
export function mapGrokLine(
  raw: string,
  sessionId: string,
  filePath: string,
  lineNumber: number,
  sourceTool: string = "grok",
): NewSessionEvent[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const row = parsed as Record<string, unknown>;

  const base = {
    sessionId,
    metadata: { source: sourceTool, path: filePath, line: lineNumber } as Record<string, unknown>,
    occurred_at: parseTimestamp(row.timestamp),
  };

  switch (row.type) {
    case "user": {
      if (typeof row.synthetic_reason === "string" && row.synthetic_reason) return [];
      const text = contentText(row.content);
      return text ? [event({ ...base, event_type: "message", role: "user", content: text })] : [];
    }
    case "assistant": {
      const out: NewSessionEvent[] = [];
      const text = contentText(row.content);
      if (text) out.push(event({ ...base, event_type: "message", role: "assistant", content: text }));
      if (Array.isArray(row.tool_calls)) {
        for (const call of row.tool_calls) {
          const formatted = formatToolCall(call);
          if (formatted === null) continue;
          out.push(
            event({
              ...base,
              event_type: "tool_call",
              role: "assistant",
              content: formatted,
              content_type: "json",
            }),
          );
        }
      }
      return out;
    }
    case "tool_result": {
      const content = contentText(row.content);
      if (!content) return [];
      return [
        event({
          ...base,
          event_type: "tool_result",
          role: "tool",
          content,
          content_type: looksLikeJson(content) ? "json" : "text",
        }),
      ];
    }
    default:
      return [];
  }
}

/**
 * Candidate group directories for a configured cwd.
 *
 * Grok encodes the path it saw, so a Windows cwd written with forward
 * slashes or a lower-case drive is also tried in Grok's own form. A cwd that
 * is already one segment (the on-disk group) is honoured literally. An
 * absolute path is never joined as a child of `sessions/`. When the encoded
 * name is too long, Grok's slug-plus-hash group records the original path in
 * a `.cwd` file; that is matched instead.
 */
export function grokGroupsForCwd(sessionsRoot: string, cwd: string): string[] {
  const { spellings, names, tooLong } = grokGroupNames(cwd);

  const dirs: string[] = [];
  for (const name of names) {
    const candidate = path.join(sessionsRoot, name);
    const rel = path.relative(sessionsRoot, candidate);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) continue;
    if (isDir(candidate)) dirs.push(candidate);
  }
  if (tooLong) {
    for (const group of listDirs(sessionsRoot)) {
      const recorded = readCwdFile(group);
      if (recorded !== null && spellings.has(recorded.replace(/[\\/]+$/, ""))) dirs.push(group);
    }
  }
  // Two spellings can name one directory on a case-insensitive disk.
  const unique = new Map<string, string>();
  for (const dir of dirs) {
    const real = realDir(dir);
    if (!unique.has(real)) unique.set(real, dir);
  }
  return [...unique.values()];
}

/**
 * The group names Grok could have written for a cwd, Grok's own spelling
 * first. Pure — init uses it to say whether the group exists without a
 * second encoding. `tooLong` means the real group is a slug found by `.cwd`.
 */
export function grokGroupNames(cwd: string): {
  spellings: Set<string>;
  names: string[];
  tooLong: boolean;
} {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const spellings = new Set<string>();
  if (!trimmed) return { spellings, names: [], tooLong: false };
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    spellings.add(trimmed[0]!.toUpperCase() + trimmed.slice(1).replace(/\//g, "\\"));
  }
  spellings.add(trimmed);

  const names = new Set<string>();
  let tooLong = false;
  for (const spelling of spellings) {
    const encoded = encodeGrokSessionDir(spelling);
    if (Buffer.byteLength(encoded, "utf8") > MAX_GROUP_BYTES) tooLong = true;
    else names.add(encoded);
  }
  if (!/[\\/]/.test(trimmed)) names.add(trimmed);
  return { spellings, names: [...names], tooLong };
}

function realDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/** Session ids that some session in any group launched as a sub-agent. */
function childSessionIds(groups: string[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const session of listDirs(group)) {
      const subagents = path.join(session, "subagents");
      if (!isDir(subagents)) continue;
      for (const child of readdirSync(subagents)) ids.add(child.replace(/\.json$/, ""));
    }
  }
  return ids;
}

function readCwdFile(group: string): string | null {
  try {
    return readFileSync(path.join(group, ".cwd"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** String content, or the text blocks of an array. Images are not text. */
function contentText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) parts.push(block);
      continue;
    }
    if (block === null || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Same `{ name, input, id }` shape the Claude Code adapter writes. */
function formatToolCall(call: unknown): string | null {
  if (call === null || typeof call !== "object") return null;
  const item = call as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : null;
  if (!name) return null;
  let input: unknown = {};
  if (typeof item.arguments === "string" && item.arguments.trim()) {
    try {
      input = JSON.parse(item.arguments);
    } catch {
      input = item.arguments;
    }
  } else if (item.arguments !== undefined) {
    input = item.arguments;
  }
  return JSON.stringify({ name, input, ...(typeof item.id === "string" ? { id: item.id } : {}) });
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function event(opts: {
  sessionId: string;
  event_type: NewSessionEvent["event_type"];
  role: NewSessionEvent["role"];
  content: string;
  content_type?: NewSessionEvent["content_type"];
  metadata: Record<string, unknown>;
  occurred_at: string | null;
}): NewSessionEvent {
  return {
    client_session_id: opts.sessionId,
    event_type: opts.event_type,
    role: opts.role,
    content: opts.content,
    content_type: opts.content_type ?? "text",
    metadata: opts.metadata,
    occurred_at: opts.occurred_at,
    speaker: null,
  };
}
