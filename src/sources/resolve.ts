/**
 * Validate and normalise `config.sources`.
 *
 * loadConfig itself stays permissive — a malformed JSON file falls back to
 * defaults rather than failing to boot — but a pull must not guess. Unknown
 * kinds, missing homes, and non-objects are rejected with a clear error so a
 * typo cannot silently become "nothing happened".
 */

import { homedir } from "node:os";
import path from "node:path";

export const SUPPORTED_SOURCE_KIND = "claude-code" as const;

export interface ResolvedCaptureSource {
  kind: typeof SUPPORTED_SOURCE_KIND;
  /** Absolute, tilde-expanded Claude Code config dir. */
  home: string;
  /** Project cwd as Claude Code would have seen it, when the source is filtered. */
  cwd?: string;
}

/** Expand a leading `~` without resolving against the local cwd. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Expand `~` and resolve to an absolute path. Used for `home`, which we open. */
export function resolveUserPath(p: string): string {
  return path.resolve(expandTilde(p));
}

/**
 * Claude Code's on-disk project group name: every non-alphanumeric character
 * becomes `-`. `C:\dev\investment` → `C--dev-investment`; `/home/me/app`
 * → `-home-me-app`. Trailing slashes are stripped so they do not become a
 * different group.
 */
export function encodeProjectDir(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Turn the configured `sources` value into a list of resolved Claude Code
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
    if (kind !== SUPPORTED_SOURCE_KIND) {
      throw new Error(
        "Unknown source kind " +
          JSON.stringify(kind) +
          " at sources[" +
          index +
          ']. This version only supports "' +
          SUPPORTED_SOURCE_KIND +
          '".',
      );
    }
    if (typeof entry.home !== "string" || entry.home.trim() === "") {
      throw new Error(
        "config.sources[" +
          index +
          '] is missing "home" (a Claude Code config dir, ' +
          "e.g. ~/.claude - the directory CLAUDE_CONFIG_DIR would point at).",
      );
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
      throw new Error(
        "config.sources[" + index + "].cwd must be a string when set.",
      );
    }

    const source: ResolvedCaptureSource = {
      kind: SUPPORTED_SOURCE_KIND,
      home: resolveUserPath(entry.home),
    };
    if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") {
      // Encode the path Claude Code itself would have used. Do not
      // path.resolve it: a Windows cwd in config (C:\dev\investment)
      // must still become C--dev-investment when this process is on
      // Linux, and resolve() would prefix the local working directory.
      source.cwd = expandTilde(entry.cwd);
    }
    resolved.push(source);
  }
  return resolved;
}
