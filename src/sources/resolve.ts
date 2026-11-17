/**
 * Validate and normalise `config.sources`.
 *
 * loadConfig itself stays permissive — a malformed JSON file falls back to
 * defaults rather than failing to boot — but a pull must not guess. Unknown
 * kinds, missing homes, and non-objects are rejected with a clear error so a
 * typo cannot silently become "nothing happened".
 */

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
 * Grok Build's on-disk session group under `~/.grok/sessions/`: the cwd
 * URL-encoded as Grok saw it. `C:\dev\app` → `C%3A%5Cdev%5Capp`;
 * `/home/me/app` → `%2Fhome%2Fme%2Fapp`. A third vocabulary, not Claude
 * Code's or Cursor's — the three must not be mixed.
 */
export function encodeGrokSessionDir(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed ? encodeURIComponent(trimmed) : "";
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
