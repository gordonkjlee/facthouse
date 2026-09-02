/**
 * Shared JSONL tail: watermark, fingerprint, insert.
 *
 * Adapters discover files and map lines. This module is the one copy
 * path so a crash cannot duplicate a line, regardless of which client
 * wrote the transcript.
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
import { ensureSession, insertEvent } from "../db/sessions.js";
import type { NewSessionEvent } from "../db/sessions.js";
import { getWatermark, upsertWatermark } from "../db/watermarks.js";

/** Window hashed at each end of the file. Prefix alone misses a rewrite
 *  (compaction) that keeps the same header. */
const FINGERPRINT_BYTES = 256;

export interface JsonlFileCopy {
  path: string;
  inserted: number;
  skipped: number;
}

export type MapTranscriptLine = (
  raw: string,
  fallbackSessionId: string,
  filePath: string,
  lineNumber: number,
  sourceTool: string,
) => NewSessionEvent[];

export interface JsonlCopyOptions {
  sourceTool: string;
  mapLine: MapTranscriptLine;
}

/**
 * Tail one JSONL file into session_events from its watermark. Inserts and the
 * watermark update share a transaction so a crash cannot duplicate a line.
 */
export async function copyJsonlFile(
  db: Db,
  filePath: string,
  opts: JsonlCopyOptions,
): Promise<JsonlFileCopy> {
  const abs = path.resolve(filePath);
  const fd = openSync(abs, "r");
  try {
    const size = fstatSync(fd).size;
    const current = fileFingerprint(fd, size);
    const existing = await getWatermark(db, abs);
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
    const sessionId = sessionIdFromPath(abs);
    const project = encodedProjectGroupFromPath(abs);
    if (lines.length === 0 && resume) {
      // File unchanged, or only an incomplete last line past the watermark.
      // Leave the watermark where it is: a later append that completes the
      // line is detected as growth and resumed from this offset.
      // Still record the conversation's project so a store that was pulled
      // before sessions.project was written gets provenance on the next pull.
      await ensureSession(db, {
        id: sessionId,
        source_tool: opts.sourceTool,
        project,
      });
      return { path: abs, inserted: 0, skipped: 0 };
    }
    let inserted = 0;
    let skipped = 0;
    let lineNumber = startLine;

    await withTransaction(db, async () => {
      const seen = new Set<string>();
      for (const line of lines) {
        lineNumber += 1;
        const mapped = opts.mapLine(line, sessionId, abs, lineNumber, opts.sourceTool);
        if (mapped.length === 0) {
          skipped += 1;
          continue;
        }
        for (const event of mapped) {
          const conversation = event.client_session_id || sessionId;
          if (!seen.has(conversation)) {
            seen.add(conversation);
            await ensureSession(db, {
              id: conversation,
              source_tool: opts.sourceTool,
              project,
            });
          }
          await insertEvent(db, event);
          inserted += 1;
        }
      }
      await upsertWatermark(db, {
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

export function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listJsonl(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(dir, entry.name));
}

export function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

/**
 * On-disk group under `home/projects/<group>/`.
 * That encoded name is the provenance we store on `sessions.project` —
 * not a tenant, and not a decoded filesystem path (encoding is lossy).
 */
export function encodedProjectGroupFromPath(filePath: string): string | null {
  const parts = path.normalize(filePath).split(path.sep);
  const i = parts.lastIndexOf("projects");
  if (i < 0 || i + 1 >= parts.length) return null;
  return parts[i + 1] || null;
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
