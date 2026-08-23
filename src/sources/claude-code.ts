/**
 * Claude Code transcript adapter.
 *
 * Read-only. Discovers session JSONL files under a configured `home` — the
 * Claude Code config dir — and maps each line onto the existing session_events
 * schema. Never writes, deletes, or rewrites anything under `home`.
 *
 * Layouts observed in the wild (both supported):
 *   home/projects/<encoded-cwd>/<session-id>.jsonl
 *   home/projects/<encoded-cwd>/sessions/<session-id>.jsonl
 *
 * `<session-id>/subagents/*.jsonl` agent transcripts are not walked.
 * Nothing outside `projects/` is walked. Optional `cwd` restricts discovery
 * to that one encoded group.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { withTransaction } from "../db/connection.js";
import type { Db } from "../db/connection.js";
import { insertEvent } from "../db/sessions.js";
import { getWatermark, upsertWatermark } from "../db/watermarks.js";
import type { NewSessionEvent } from "../db/sessions.js";
import { encodeProjectDir, type ResolvedCaptureSource } from "./resolve.js";

/** Window hashed at each end of the file. Prefix alone misses a rewrite
 *  (compaction) that keeps the same header. */
const FINGERPRINT_BYTES = 256;

const SKIP_TYPES = new Set([
  "system",
  "progress",
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "queue-operation",
  "summary",
  "custom-title",
  "compact",
  // UI / resume snapshots observed on Claude Code JSONL. Skipped rather
  // than forced into a role they are not. Fallthrough would skip them
  // anyway (no role/message); listing them keeps that honest.
  "last-prompt",
  "mode",
  "permission-mode",
  "ai-title",
  "agent-name",
  "atis-latch",
]);

export interface ClaudeCodeFilePull {
  path: string;
  inserted: number;
  skipped: number;
}

/**
 * Discover session JSONL files for one configured Claude Code home.
 * Returns absolute paths, sorted, so tests (and watermarks) are stable.
 */
export function discoverClaudeCodeFiles(source: ResolvedCaptureSource): string[] {
  const projectsRoot = path.join(source.home, "projects");
  if (!isDir(projectsRoot)) return [];

  const groups = listProjectGroups(projectsRoot, source.cwd);
  const files: string[] = [];
  for (const group of groups) {
    files.push(...listJsonl(group));
    const sessionsDir = path.join(group, "sessions");
    if (isDir(sessionsDir)) {
      files.push(...listJsonl(sessionsDir));
      // Some versions nest one more level under sessions/<id>/.
      for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        files.push(...listJsonl(path.join(sessionsDir, entry.name)));
      }
    }
  }
  return [...new Set(files)].sort();
}

/**
 * Tail one JSONL file into session_events from its watermark. Inserts and the
 * watermark update share a transaction so a crash cannot duplicate a line.
 */
export function ingestClaudeCodeFile(db: Db, filePath: string): ClaudeCodeFilePull {
  const abs = path.resolve(filePath);
  const fd = openSync(abs, "r");
  try {
    const size = fstatSync(fd).size;
    const current = fileFingerprint(fd, size);
    const existing = getWatermark(db, abs);
    const resume =
      existing &&
      existing.byte_offset <= size &&
      shouldResumeFromWatermark(fd, existing.fingerprint, existing.byte_offset, current)
        ? existing
        : null;
    const fingerprint = current.encoded;
    const startOffset = resume?.byte_offset ?? 0;
    const startLine = resume?.line_number ?? 0;

    const { lines, endOffset } = readCompleteLines(fd, startOffset, size);
    if (lines.length === 0 && resume) {
      // File unchanged, or only an incomplete last line past the watermark.
      // Leave the watermark where it is: a later append that completes the
      // line is detected as growth and resumed from this offset.
      return { path: abs, inserted: 0, skipped: 0 };
    }

    const sessionId = sessionIdFromPath(abs);
    let inserted = 0;
    let skipped = 0;
    let lineNumber = startLine;

    withTransaction(db, () => {
      for (const line of lines) {
        lineNumber += 1;
        const mapped = mapTranscriptLine(line, sessionId, abs, lineNumber);
        if (mapped.length === 0) {
          skipped += 1;
          continue;
        }
        for (const event of mapped) {
          insertEvent(db, event);
          inserted += 1;
        }
      }
      upsertWatermark(db, {
        path: abs,
        byte_offset: endOffset,
        line_number: lineNumber,
        fingerprint,
      });
    });

    return { path: abs, inserted, skipped };
  } finally {
    closeSync(fd);
  }
}

/**
 * Map one JSONL line onto zero or more session_events.
 *
 * Faithful where the line format is honest: user / assistant text, tool_use,
 * tool_result. System and other meta records are skipped rather than forced
 * into a role they are not.
 */
export function mapTranscriptLine(
  raw: string,
  fallbackSessionId: string,
  filePath: string,
  lineNumber: number,
): NewSessionEvent[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const row = parsed as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type : undefined;
  if (type && SKIP_TYPES.has(type)) return [];
  // Claude Code marks hook output, caveats, and system-reminders with
  // isMeta. Those are not user turns — ingesting them as role:user is
  // the same class of error as labelling a tool_result a user message.
  if (row.isMeta === true) return [];

  const sessionId =
    (typeof row.sessionId === "string" && row.sessionId) ||
    (typeof row.session_id === "string" && row.session_id) ||
    fallbackSessionId;

  const message =
    row.message !== null && typeof row.message === "object" && !Array.isArray(row.message)
      ? (row.message as Record<string, unknown>)
      : null;

  const provenance: Record<string, unknown> = {
    source: "claude-code",
    path: filePath,
    line: lineNumber,
  };

  if (type === "user" || type === "human") {
    return mapUserOrToolResult(message ?? row, sessionId, provenance);
  }
  if (type === "assistant") {
    return mapAssistant(message ?? row, sessionId, provenance);
  }
  if (type === "tool_result") {
    const content = extractToolResultContent(row);
    if (content === null) return [];
    return [
      event({
        sessionId,
        event_type: "tool_result",
        role: "tool",
        content,
        content_type: looksLikeJson(content) ? "json" : "text",
        metadata: provenance,
      }),
    ];
  }
  if (type === "tool_use") {
    const content = formatToolUse(row);
    if (content === null) return [];
    return [
      event({
        sessionId,
        event_type: "tool_call",
        role: "assistant",
        content,
        content_type: "json",
        metadata: provenance,
      }),
    ];
  }

  // Bare role/content records (some exports drop `type`).
  const role = typeof row.role === "string" ? row.role : undefined;
  if (role === "user" || role === "human") {
    return mapUserOrToolResult(row, sessionId, provenance);
  }
  if (role === "assistant") {
    return mapAssistant(row, sessionId, provenance);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

function listProjectGroups(projectsRoot: string, cwd?: string): string[] {
  if (cwd) {
    const encoded = encodeProjectDir(cwd);
    const candidate = path.join(projectsRoot, encoded);
    return isDir(candidate) ? [candidate] : [];
  }
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name));
}

function listJsonl(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(dir, entry.name));
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

// ---------------------------------------------------------------------------
// Byte-accurate tail
// ---------------------------------------------------------------------------

export interface FileFingerprint {
  prefix: string;
  suffix: string;
  size: number;
  encoded: string;
}

function hashWindow(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  if (length > 0) readSync(fd, buf, 0, length, position);
  return createHash("sha256").update(buf).digest("hex");
}

/** Prefix + suffix + size. Compaction that keeps a stable header still
 *  changes the tail or the length, so the watermark resets. */
export function fileFingerprint(fd: number, size: number): FileFingerprint {
  const n = Math.min(FINGERPRINT_BYTES, size);
  const prefix = hashWindow(fd, 0, n);
  const suffix = hashWindow(fd, Math.max(0, size - n), n);
  return { prefix, suffix, size, encoded: `${prefix}:${suffix}:${size}` };
}

export function parseFingerprint(encoded: string): {
  prefix: string;
  suffix: string;
  size: number;
} | null {
  const parts = encoded.split(":");
  if (parts.length !== 3) return null;
  const size = Number(parts[2]);
  if (!Number.isFinite(size)) return null;
  return { prefix: parts[0], suffix: parts[1], size };
}

/**
 * Unchanged file: resume. Append (header still in place, grew, old tail
 * still at the previous end): resume. Anything else — including a compacted
 * body behind the same header — reset.
 *
 * Do not compare `current.prefix` to `prev.prefix` when the file is shorter
 * than the fingerprint window: that hash covers the whole file, so a one-byte
 * append changes the prefix and looks like a rewrite.
 */
export function shouldResumeFromWatermark(
  fd: number,
  stored: string,
  byteOffset: number,
  current: FileFingerprint,
): boolean {
  if (stored === current.encoded && byteOffset <= current.size) return true;
  const prev = parseFingerprint(stored);
  if (!prev) return false;
  if (current.size < prev.size || byteOffset > current.size) return false;
  const prefixLen = Math.min(FINGERPRINT_BYTES, prev.size);
  if (hashWindow(fd, 0, prefixLen) !== prev.prefix) return false;
  if (current.size === prev.size) return prev.suffix === current.suffix;
  // Grew: only treat as an append if the previous tail is still where it was.
  const oldWindow = Math.min(FINGERPRINT_BYTES, prev.size);
  const stillThere = hashWindow(fd, Math.max(0, prev.size - oldWindow), oldWindow);
  return stillThere === prev.suffix;
}

/**
 * Read from `startOffset` to EOF and return only complete lines (those
 * terminated by `\\n`). The returned `endOffset` is the byte position after
 * the last complete line, so a file still being written is not consumed past
 * a partial line.
 */
function readCompleteLines(
  fd: number,
  startOffset: number,
  size: number,
): { lines: string[]; endOffset: number } {
  const remaining = size - startOffset;
  if (remaining <= 0) return { lines: [], endOffset: startOffset };

  const buf = Buffer.alloc(remaining);
  const bytesRead = readSync(fd, buf, 0, remaining, startOffset);
  const slice = buf.subarray(0, bytesRead);
  const lastNl = slice.lastIndexOf(0x0a);
  if (lastNl === -1) return { lines: [], endOffset: startOffset };

  const complete = slice.subarray(0, lastNl + 1);
  const text = complete.toString("utf8");
  const lines = text.split("\n");
  // split() after a trailing newline yields a final empty string — drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { lines, endOffset: startOffset + complete.length };
}

// ---------------------------------------------------------------------------
// Line mapping
// ---------------------------------------------------------------------------

function mapUserOrToolResult(
  message: Record<string, unknown>,
  sessionId: string,
  provenance: Record<string, unknown>,
): NewSessionEvent[] {
  const content = message.content;
  if (typeof content === "string") {
    const text = content.trim();
    if (!text) return [];
    return [
      event({
        sessionId,
        event_type: "message",
        role: "user",
        content: text,
        metadata: provenance,
      }),
    ];
  }
  if (!Array.isArray(content)) return [];

  const out: NewSessionEvent[] = [];
  const texts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "tool_result") {
      const result = extractToolResultContent(item);
      if (result === null) continue;
      out.push(
        event({
          sessionId,
          event_type: "tool_result",
          role: "tool",
          content: result,
          content_type: looksLikeJson(result) ? "json" : "text",
          metadata: provenance,
        }),
      );
      continue;
    }
    const text = blockText(item);
    if (text) texts.push(text);
  }
  if (texts.length > 0) {
    out.unshift(
      event({
        sessionId,
        event_type: "message",
        role: "user",
        content: texts.join("\n"),
        metadata: provenance,
      }),
    );
  }
  return out;
}

function mapAssistant(
  message: Record<string, unknown>,
  sessionId: string,
  provenance: Record<string, unknown>,
): NewSessionEvent[] {
  const content = message.content;
  if (typeof content === "string") {
    const text = content.trim();
    if (!text) return [];
    return [
      event({
        sessionId,
        event_type: "message",
        role: "assistant",
        content: text,
        metadata: provenance,
      }),
    ];
  }
  if (!Array.isArray(content)) return [];

  const out: NewSessionEvent[] = [];
  const texts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "tool_use") {
      const formatted = formatToolUse(item);
      if (formatted === null) continue;
      out.push(
        event({
          sessionId,
          event_type: "tool_call",
          role: "assistant",
          content: formatted,
          content_type: "json",
          metadata: provenance,
        }),
      );
      continue;
    }
    if (item.type === "thinking") continue;
    const text = blockText(item);
    if (text) texts.push(text);
  }
  if (texts.length > 0) {
    out.unshift(
      event({
        sessionId,
        event_type: "message",
        role: "assistant",
        content: texts.join("\n"),
        metadata: provenance,
      }),
    );
  }
  return out;
}

function blockText(item: Record<string, unknown>): string | null {
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }
  return null;
}

function formatToolUse(item: Record<string, unknown>): string | null {
  const name = typeof item.name === "string" ? item.name : null;
  if (!name) return null;
  return JSON.stringify({
    name,
    input: item.input ?? {},
    ...(typeof item.id === "string" ? { id: item.id } : {}),
  });
}

function extractToolResultContent(item: Record<string, unknown>): string | null {
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          const text = (block as { text?: unknown }).text;
          return typeof text === "string" ? text : null;
        }
        return null;
      })
      .filter((p): p is string => p !== null && p !== "");
    if (parts.length === 0) return null;
    return parts.join("\n");
  }
  if (content !== null && content !== undefined) {
    try {
      return JSON.stringify(content);
    } catch {
      return null;
    }
  }
  return null;
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  );
}

function event(opts: {
  sessionId: string;
  event_type: NewSessionEvent["event_type"];
  role: NewSessionEvent["role"];
  content: string;
  content_type?: NewSessionEvent["content_type"];
  metadata: Record<string, unknown>;
}): NewSessionEvent {
  return {
    client_session_id: opts.sessionId,
    event_type: opts.event_type,
    role: opts.role,
    content: opts.content,
    content_type: opts.content_type ?? "text",
    metadata: opts.metadata,
  };
}
