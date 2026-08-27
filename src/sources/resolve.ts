/**
 * Validate and normalise `config.sources`.
 *
 * loadConfig itself stays permissive — a malformed JSON file falls back to
 * defaults rather than failing to boot — but a pull must not guess. Unknown
 * kinds, missing homes, and non-objects are rejected with a clear error so a
 * typo cannot silently become "nothing happened".
 */

import {
  CAPTURE_SOURCE_KINDS,
  isCaptureSourceKind,
  type CaptureSourceKind,
} from "../types/config.js";
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

function supportedKindsList(): string {
  return CAPTURE_SOURCE_KINDS.map((k) => `"${k}"`).join(" and ");
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
          supportedKindsList() +
          ".",
      );
    }
    if (typeof entry.home !== "string" || entry.home.trim() === "") {
      throw new Error(
        "config.sources[" +
          index +
          '] is missing "home" (the client config dir, ' +
          "e.g. ~/.claude for claude-code or ~/.cursor for cursor).",
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
