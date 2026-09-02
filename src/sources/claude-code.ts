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

import { readdirSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/connection.js";
import { speakerNameOf } from "../db/session-facts.js";
import type { NewSessionEvent } from "../db/sessions.js";
import {
  copyJsonlFile,
  isDir,
  listJsonl,
  type JsonlFileCopy,
} from "./jsonl-copy.js";
import { encodeProjectDir, type ResolvedCaptureSource } from "./resolve.js";

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
  // Cursor Agent JSONL (and some Claude Code exports) emit a terminal
  // marker with no role and no speech. Skip rather than fall through.
  "turn_ended",
]);

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

/** Tail one Claude Code JSONL file into session_events. */
export async function copyClaudeCodeFile(db: Db, filePath: string): Promise<JsonlFileCopy> {
  return await copyJsonlFile(db, filePath, {
    sourceTool: "claude-code",
    mapLine: mapTranscriptLine,
  });
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
  sourceTool: string = "claude-code",
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
  // isMeta. Those are not user turns — copying them as role:user is
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
    source: sourceTool,
    path: filePath,
    line: lineNumber,
  };
  // Transcript clock, not copy time. Null when the line has no usable
  // timestamp — copying created_at would pretend we know when it was said.
  const occurredAt = parseJsonlTimestamp(row.timestamp);
  // Named participant only when the line has `speaker`. Do not guess
  // userName / author — those are not this field.
  const speaker = speakerNameOf(row.speaker);

  if (type === "user" || type === "human") {
    return mapUserOrToolResult(
      message ?? row,
      sessionId,
      provenance,
      occurredAt,
      speaker,
    );
  }
  if (type === "assistant") {
    return mapAssistant(message ?? row, sessionId, provenance, occurredAt, speaker);
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
        occurred_at: occurredAt,
        speaker,
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
        occurred_at: occurredAt,
        speaker,
      }),
    ];
  }

  // Bare role/content records (Cursor Agent JSONL, and some Claude Code
  // exports, drop `type`). Content lives on `message` the same way typed
  // lines do — mapping `row` here missed every Cursor user/assistant turn.
  const role = typeof row.role === "string" ? row.role : undefined;
  if (role === "user" || role === "human") {
    return mapUserOrToolResult(
      message ?? row,
      sessionId,
      provenance,
      occurredAt,
      speaker,
    );
  }
  if (role === "assistant") {
    return mapAssistant(message ?? row, sessionId, provenance, occurredAt, speaker);
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

// ---------------------------------------------------------------------------
// Line mapping
// ---------------------------------------------------------------------------

function mapUserOrToolResult(
  message: Record<string, unknown>,
  sessionId: string,
  provenance: Record<string, unknown>,
  occurredAt: string | null,
  speaker: string | null,
): NewSessionEvent[] {
  const content = message.content;
  if (typeof content === "string") {
    const text = spokenUserText(content);
    if (!text) return [];
    return [
      event({
        sessionId,
        event_type: "message",
        role: "user",
        content: text,
        metadata: provenance,
        occurred_at: occurredAt,
        speaker,
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
          occurred_at: occurredAt,
          speaker,
        }),
      );
      continue;
    }
    const text = spokenUserText(blockText(item) ?? "");
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
        occurred_at: occurredAt,
        speaker,
      }),
    );
  }
  return out;
}

function mapAssistant(
  message: Record<string, unknown>,
  sessionId: string,
  provenance: Record<string, unknown>,
  occurredAt: string | null,
  speaker: string | null,
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
        occurred_at: occurredAt,
        speaker,
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
          occurred_at: occurredAt,
          speaker,
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
        occurred_at: occurredAt,
        speaker,
      }),
    );
  }
  return out;
}

/**
 * Cursor wraps the uttered prompt in `<user_query>`. When that tag is
 * present, the rest of the line is environment chrome (timestamp, open
 * files), not speech — keep the inner text only. Claude Code lines without
 * the tag are unchanged.
 */
function spokenUserText(text: string): string {
  const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  if (matches.length > 0) return matches.join("\n");
  return text.trim();
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

function parseJsonlTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function event(opts: {
  sessionId: string;
  event_type: NewSessionEvent["event_type"];
  role: NewSessionEvent["role"];
  content: string;
  content_type?: NewSessionEvent["content_type"];
  metadata: Record<string, unknown>;
  occurred_at?: string | null;
  speaker?: string | null;
}): NewSessionEvent {
  return {
    client_session_id: opts.sessionId,
    event_type: opts.event_type,
    role: opts.role,
    content: opts.content,
    content_type: opts.content_type ?? "text",
    metadata: opts.metadata,
    occurred_at: opts.occurred_at ?? null,
    speaker: opts.speaker ?? null,
  };
}
