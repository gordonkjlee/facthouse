/**
 * Validate and normalise `config.sources`.
 *
 * loadConfig itself stays permissive — a malformed JSON file falls back to
 * defaults rather than failing to boot — but a pull must not guess. Unknown
 * kinds, missing homes, and non-objects are rejected with a clear error so a
 * typo cannot silently become "nothing happened".
 */

import { blake3 } from "@noble/hashes/blake3";
import {
  captureSourceKindsList,
  isCaptureSourceKind,
  type CaptureSourceKind,
} from "../types/config.js";
import type { ContextVerdict } from "../types/data.js";
import { expandTilde, resolveUserPath } from "../paths.js";

export { expandTilde, resolveUserPath } from "../paths.js";

export interface ResolvedCaptureSource {
  kind: CaptureSourceKind;
  /** Absolute, tilde-expanded client config dir. */
  home: string;
  /** Project cwd as the client would have seen it, when the source is filtered. */
  cwd?: string;
}

/**
 * Claude Code's on-disk project group name: every non-alphanumeric character
 * becomes `-`. `C:\dev\app` → `C--dev-app`; `/home/me/app`
 * → `-home-me-app`. Trailing slashes are stripped so they do not become a
 * different group.
 */
export function encodeProjectDir(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Cursor's on-disk project group name under `~/.cursor/projects/`.
 * Lowercase, non-alphanumeric runs become one `-`, edges stripped.
 * `C:\dev\app` → `c-dev-app`; `/home/me/app` → `home-me-app`.
 * Not Claude Code's encoding (`C--dev-app`) — the two must not be mixed.
 */
export function encodeCursorProjectDir(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Bytes in one directory name (APFS, ext4, NTFS). Grok's `MAX_DIRNAME_BYTES`.
 * crates/codegen/xai-grok-config/src/paths.rs line 56.
 */
const GROK_DIRNAME_MAX_BYTES = 255;

/** `slugify(..., 40)` then `-` then 16 hex chars. paths.rs lines 72-77. */
const GROK_SLUG_MAX_CHARS = 40;
const GROK_HASH_HEX_CHARS = 16;

/**
 * Grok Build's session-group directory under `~/.grok/sessions/`.
 *
 * `encode_cwd_dirname` in crates/codegen/xai-grok-config/src/paths.rs
 * lines 61-78 (grok-build 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) percent-encodes
 * the cwd with Rust `urlencoding` 2.1.3 `encode`: UTF-8 bytes, keep
 * `A-Z a-z 0-9 - . _ ~`, escape every other byte as uppercase `%XX`.
 * `C:\dev\app` → `C%3A%5Cdev%5Capp`; `/home/me/app` → `%2Fhome%2Fme%2Fapp`.
 * Trailing slashes are stripped first, so a configured `C:\dev\app\` matches
 * the directory Grok created from `current_dir` (no trailing separator).
 * The same stripped string is what gets hashed below.
 *
 * When that name is longer than 255 bytes, the directory is
 * `{slug}-{hex16}`. `slug` is `slugify(file_name, 40)` (paths.rs lines 179-193);
 * an empty slug becomes `workspace`. `hex16` is the first 16 chars of
 * `blake3::hash(cwd.as_bytes()).to_hex()` (paths.rs lines 66-67). `file_name`
 * (paths.rs lines 68-71) is Rust `Path`: a drive-letter or UNC cwd was written
 * on Windows, so both `\` and `/` separate it; any other cwd was written on
 * Unix, so only `/` separates it.
 */
export function encodeGrokSessionDir(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const encoded = encodeUrlencoding(trimmed);
  if (Buffer.byteLength(encoded, "utf8") <= GROK_DIRNAME_MAX_BYTES) return encoded;
  const slug = slugify(grokCwdLeaf(trimmed), GROK_SLUG_MAX_CHARS);
  return `${slug === "" ? "workspace" : slug}-${blake3Hex16(trimmed)}`;
}

/** Rust `urlencoding::encode` (crate 2.1.3): unreserved bytes only, uppercase hex. */
function encodeUrlencoding(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** First 16 lowercase hex chars of BLAKE3(UTF-8 cwd). blake3 1.8 `hash().to_hex()`. */
function blake3Hex16(cwd: string): string {
  const digest = blake3(Buffer.from(cwd, "utf8"));
  return Buffer.from(digest).toString("hex").slice(0, GROK_HASH_HEX_CHARS);
}

/**
 * `slugify` in paths.rs lines 179-193: lowercase, ASCII alphanumerics kept,
 * every other run becomes one `-`, edges trimmed, then at most `maxLen` chars.
 */
function slugify(input: string, maxLen: number): string {
  let result = "";
  let prevDash = false;
  for (const char of input.toLowerCase()) {
    const code = char.codePointAt(0) ?? 0;
    const asciiAlnum =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (asciiAlnum) {
      result += char;
      prevDash = false;
    } else if (!prevDash) {
      result += "-";
      prevDash = true;
    }
  }
  const trimmed = result.replace(/^-+|-+$/g, "");
  return Array.from(trimmed).slice(0, maxLen).join("");
}

/**
 * Last normal path component, or `workspace` when Rust `Path::file_name`
 * would be `None` (`..`, `.`, or a root).
 */
function grokCwdLeaf(cwd: string): string {
  const windows = /^[A-Za-z]:/.test(cwd) || cwd.startsWith("\\\\");
  let parts: string[];
  if (!windows) {
    parts = cwd.split("/");
  } else if (cwd.startsWith("\\\\")) {
    parts = cwd.slice(2).split(/[\\/]/).slice(2);
  } else {
    parts = cwd.slice(2).split(/[\\/]/);
  }
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  const last = parts[parts.length - 1];
  if (last === undefined || last === "." || last === "..") return "workspace";
  return last;
}

/**
 * One comparable key for the project a session was recorded in.
 *
 * `sessions.project` keeps the client's own group name. Callers compare
 * keys; they do not rewrite the stored value. There is one normal form,
 * `encodeCursorProjectDir` — no second encoding lives here.
 *
 * Returns null when `v` carries no cwd: null or blank, an opaque numeric
 * id (`/^\d+$/`), a percent-encoded group whose escape is malformed, or a
 * slug-plus-hash group (`-[0-9a-f]{16}`, at most 57 bytes) that does not
 * contain the original path. A percent-encoded group (it contains `%` and
 * matches `/^[A-Za-z0-9._~%-]+$/`) is decoded first. Anything else is used
 * as stored, then passed through `encodeCursorProjectDir`.
 */
export function projectKey(v: string | null): string | null {
  if (v == null || v.trim() === "" || /^\d+$/.test(v)) return null;

  let raw: string;
  if (v.includes("%") && /^[A-Za-z0-9._~%-]+$/.test(v)) {
    try {
      raw = decodeURIComponent(v);
    } catch {
      return null;
    }
  } else if (/-[0-9a-f]{16}$/.test(v) && Buffer.byteLength(v, "utf8") <= 57) {
    return null;
  } else {
    raw = v;
  }

  const key = encodeCursorProjectDir(raw);
  return key === "" ? null : key;
}

/**
 * How two recorded project values relate. The decision uses only their
 * keys — never which client wrote the session.
 *
 * `not_comparable` when either key is null (including both). `same` when
 * the keys are equal, or when one is a `-`-delimited prefix of the other
 * (a worktree or a subdirectory launch of the same project). Otherwise
 * `different`.
 */
export function projectRelation(
  a: string | null,
  b: string | null,
): ContextVerdict {
  const left = projectKey(a);
  const right = projectKey(b);
  if (left == null || right == null) return "not_comparable";
  if (left === right) return "same";
  if (left.startsWith(right + "-") || right.startsWith(left + "-")) return "same";
  return "different";
}

/**
 * Turn the configured `sources` value into a list of resolved capture
 * homes. Empty / omitted is a successful no-op — pull is off. Anything else
 * that is not a supported source throws.
 */
export function resolveSources(sources: unknown): ResolvedCaptureSource[] {
  if (sources == null) return [];
  if (!Array.isArray(sources)) {
    throw new Error(
      "config.sources must be an array of { kind, home, cwd? } (got " +
        typeof sources +
        ").",
    );
  }

  const resolved: ResolvedCaptureSource[] = [];
  for (const [index, raw] of sources.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        "config.sources[" + index + "] must be an object with kind and home.",
      );
    }
    const entry = raw as Record<string, unknown>;
    const kind = entry.kind;
    if (!isCaptureSourceKind(kind)) {
      throw new Error(
        "Unknown source kind " +
          JSON.stringify(kind) +
          " at sources[" +
          index +
          "]. This version supports " +
          captureSourceKindsList() +
          ".",
      );
    }
    if (typeof entry.home !== "string" || entry.home.trim() === "") {
      throw new Error(
        "config.sources[" +
          index +
          '] is missing "home" (the client config dir, ' +
          "e.g. ~/.claude for claude-code, ~/.cursor for cursor, ~/.grok for grok).",
      );
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
      throw new Error(
        "config.sources[" + index + "].cwd must be a string when set.",
      );
    }

    const source: ResolvedCaptureSource = {
      kind,
      home: resolveUserPath(entry.home),
    };
    if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") {
      // Encode the path the client itself would have used. Do not
      // path.resolve it: a Windows cwd in config (C:\dev\app)
      // must still become the client's on-disk group when this process
      // is on Linux, and resolve() would prefix the local working directory.
      source.cwd = expandTilde(entry.cwd);
    }
    resolved.push(source);
  }
  return resolved;
}
