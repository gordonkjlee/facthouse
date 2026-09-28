/**
 * Grok Build transcript adapter.
 *
 * Read-only. Discovers `chat_history.jsonl` under a configured `home`
 * (`GROK_HOME` or `~/.grok`) and maps each line onto session_events.
 * Never writes, deletes, or rewrites anything under `home`.
 *
 * Layout:
 *   home/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl
 *
 * The group name is the cwd URL-encoded the way Grok writes it
 * (`C:\dev\app` → `C%3A%5Cdev%5Capp`). When that name would exceed 255
 * bytes, Grok uses a slug-plus-hash directory and records the original
 * path in `<group>/.cwd`. An absolute Windows cwd is never joined as a
 * child of `sessions/` — that escapes the home.
 *
 * Only `chat_history.jsonl` is copied. `updates.jsonl` is the chunked
 * ACP restore stream. Reasoning, hooks, compaction, and encrypted blobs
 * are skipped. Child sessions (a parent id in `summary.json`, or a
 * session id listed under another session's `subagents/`) are not
 * discovered. Nothing outside `home/sessions/` is walked.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/connection.js";
import type { NewSessionEvent } from "../db/sessions.js";
import { copyJsonlFile, isDir, type JsonlFileCopy } from "./jsonl-copy.js";
import { encodeGrokProjectDir, type ResolvedCaptureSource } from "./resolve.js";

/** Injected context, not a user turn. Hooks and compaction live here too. */
const SKIP_USER_REASONS = new Set([
  "compaction_meta",
  "stop_hook_feedback",
  "system_reminder",
  "project_instructions",
  "session_prefix",
  "agent_message",
]);

const SKIP_TYPES = new Set([
  "reasoning",
  "system",
  "backend_tool_call",
  "hook",
  "hook_execution",
  "compaction",
  "compact",
]);

/**
 * Candidate on-disk group name for a configured cwd.
 *
 * Absolute paths are encoded, never returned as a child of `sessions/`
 * (on Windows `path.join(root, "C:\\dev\\app")` is `C:\dev\\app`).
 */
export function grokGroupNames(cwd: string): string[] {
  const encoded = encodeGrokProjectDir(cwd);
  if (!encoded || encoded === "." || encoded === ".." || /[\\/]/.test(encoded)) {
    return [];
  }
  return [encoded];
}

/**
 * Discover Grok `chat_history.jsonl` files for one configured home.
 * Returns absolute paths, sorted, so tests (and watermarks) are stable.
 */
export function discoverGrokFiles(source: ResolvedCaptureSource): string[] {
  const sessionsRoot = path.join(source.home, "sessions");
  if (!isDir(sessionsRoot)) return [];

  const files: string[] = [];
  for (const group of listGrokGroups(sessionsRoot, source.cwd)) {
    files.push(...chatHistoriesInGroup(group));
  }
  return [...new Set(files)].sort();
}

/** Tail one Grok `chat_history.jsonl` into session_events. */
export async function copyGrokFile(db: Db, filePath: string): Promise<JsonlFileCopy> {
  const abs = path.resolve(filePath);
  // The session id is the directory name, not the filename `chat_history`.
  const sessionId = path.basename(path.dirname(abs));
  return await copyJsonlFile(db, abs, {
    sourceTool: "grok",
    mapLine: (raw, _fallback, file, lineNumber, sourceTool) =>
      mapGrokLine(raw, sessionId, file, lineNumber, sourceTool),
  });
}

/**
 * Map one Grok `chat_history.jsonl` line onto zero or more session_events.
 *
 * User, assistant, and tool_result lines become rows. `tool_calls` on an
 * assistant line become `tool_call` events. Reasoning, system, hooks,
 * compaction, backend tool calls, and encrypted blobs are skipped.
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
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const row = parsed as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type : undefined;
  if (!type || SKIP_TYPES.has(type)) return [];
  // A reasoning line is the encrypted blob. Do not mine summary text out of it.
  if (typeof row.encrypted_content === "string") return [];

  const provenance: Record<string, unknown> = {
    source: sourceTool,
    source_tool: sourceTool,
    path: filePath,
    line: lineNumber,
  };
  const occurredAt = parseJsonlTimestamp(row.timestamp ?? row.created_at);

  if (type === "user") {
    const reason = typeof row.synthetic_reason === "string" ? row.synthetic_reason : "";
    if (reason && SKIP_USER_REASONS.has(reason)) return [];
    const text = spokenText(textContent(row.content));
    if (!text) return [];
    return [
      event({
        sessionId,
        event_type: "message",
        role: "user",
        content: text,
        metadata: provenance,
        occurred_at: occurredAt,
      }),
    ];
  }

  if (type === "assistant") {
    const out: NewSessionEvent[] = [];
    const text = textContent(row.content).trim();
    if (text) {
      out.push(
        event({
          sessionId,
          event_type: "message",
          role: "assistant",
          content: text,
          metadata: provenance,
          occurred_at: occurredAt,
        }),
      );
    }
    if (Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        if (call === null || typeof call !== "object" || Array.isArray(call)) continue;
        const formatted = formatToolCall(call as Record<string, unknown>);
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
          }),
        );
      }
    }
    return out;
  }

  if (type === "tool_result") {
    const content = toolResultText(row.content);
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
      }),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listGrokGroups(sessionsRoot: string, cwd?: string): string[] {
  if (!cwd) {
    return readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => safeGroupDir(sessionsRoot, entry.name))
      .filter((dir): dir is string => dir !== null);
  }

  const seen = new Set<string>();
  const dirs: string[] = [];
  const add = (dir: string | null) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };

  for (const name of grokGroupNames(cwd)) {
    add(safeGroupDir(sessionsRoot, name));
  }

  let entries;
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = safeGroupDir(sessionsRoot, entry.name);
    if (!dir) continue;
    const cwdFile = path.join(dir, ".cwd");
    if (!isFile(cwdFile)) continue;
    let text: string;
    try {
      text = readFileSync(cwdFile, "utf8");
    } catch {
      continue;
    }
    if (cwdTextMatches(text, cwd)) add(dir);
  }
  return dirs;
}

function safeGroupDir(sessionsRoot: string, name: string): string | null {
  if (!name || name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  const candidate = path.join(sessionsRoot, name);
  const rel = path.relative(sessionsRoot, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return isDir(candidate) ? candidate : null;
}

function cwdTextMatches(fileText: string, cwd: string): boolean {
  const recorded = fileText.trim().replace(/[\\/]+$/, "");
  const wanted = cwd.trim().replace(/[\\/]+$/, "");
  return recorded !== "" && recorded === wanted;
}

function chatHistoriesInGroup(group: string): string[] {
  let entries;
  try {
    entries = readdirSync(group, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: Array<{ id: string; chat: string }> = [];
  const childIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(group, entry.name);
    const rel = path.relative(group, dir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;

    if (summaryNamesParent(path.join(dir, "summary.json"))) {
      childIds.add(entry.name);
    }
    for (const id of idsListedUnderSubagents(path.join(dir, "subagents"))) {
      childIds.add(id);
    }

    const chat = path.join(dir, "chat_history.jsonl");
    if (isFile(chat)) sessions.push({ id: entry.name, chat });
  }

  return sessions.filter((session) => !childIds.has(session.id)).map((session) => session.chat);
}

function summaryNamesParent(summaryPath: string): boolean {
  const parsed = readJson(summaryPath);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const row = parsed as Record<string, unknown>;
  if (nonEmptyString(row.parent_session_id) || nonEmptyString(row.parentSessionId)) {
    return true;
  }
  const kind = typeof row.session_kind === "string" ? row.session_kind : "";
  return kind === "subagent" || kind.startsWith("subagent ");
}

function idsListedUnderSubagents(subDir: string): string[] {
  if (!isDir(subDir)) return [];
  let entries;
  try {
    entries = readdirSync(subDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      ids.push(entry.name);
      ids.push(...idsFromMeta(path.join(subDir, entry.name, "meta.json")));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === "meta.json") {
      ids.push(...idsFromMeta(path.join(subDir, entry.name)));
      continue;
    }
    if (entry.name.endsWith(".json")) {
      ids.push(entry.name.slice(0, -".json".length));
    }
  }
  return ids.filter((id) => id !== "" && id !== "meta");
}

function idsFromMeta(metaPath: string): string[] {
  const parsed = readJson(metaPath);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const row = parsed as Record<string, unknown>;
  const ids: string[] = [];
  for (const key of ["session_id", "sessionId", "id"]) {
    if (nonEmptyString(row[key])) ids.push(row[key] as string);
  }
  return ids;
}

function readJson(filePath: string): unknown {
  if (!isFile(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// ---------------------------------------------------------------------------
// Line mapping
// ---------------------------------------------------------------------------

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) parts.push(block);
      continue;
    }
    if (block === null || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "image") continue;
    if (typeof item.text === "string" && item.text.trim()) parts.push(item.text);
  }
  return parts.join("\n");
}

/**
 * Grok wraps the uttered prompt in `<user_query>`. When that tag is
 * present, keep the inner text. Lines without the tag are unchanged.
 */
function spokenText(text: string): string {
  const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  if (matches.length > 0) return matches.join("\n");
  return text.trim();
}

function formatToolCall(call: Record<string, unknown>): string | null {
  const name = typeof call.name === "string" ? call.name : null;
  if (!name) return null;
  const args = call.arguments ?? call.input;
  let input: unknown = {};
  if (typeof args === "string") {
    try {
      input = JSON.parse(args);
    } catch {
      input = args;
    }
  } else if (args !== undefined) {
    input = args;
  }
  return JSON.stringify({
    name,
    input,
    ...(typeof call.id === "string" ? { id: call.id } : {}),
  });
}

function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    const text = textContent(content).trim();
    if (text) return text;
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
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
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
}): NewSessionEvent {
  return {
    client_session_id: opts.sessionId,
    event_type: opts.event_type,
    role: opts.role,
    content: opts.content,
    content_type: opts.content_type ?? "text",
    metadata: opts.metadata,
    occurred_at: opts.occurred_at ?? null,
    speaker: null,
  };
}
