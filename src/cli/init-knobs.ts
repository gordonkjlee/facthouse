/**
 * The only knobs `factmem init` is allowed to ask about.
 *
 * Silent values are expressions of DEFAULT_CONFIG / defaultDataDir(), not
 * copied literals. Prompt copy lives here so the wizard and tests cannot grow
 * a second vocabulary. Extra knobs go on MORE_SETTING_IDS, not a fourth
 * question inlined in init.ts.
 */

import {
  DEFAULT_CONFIG,
  CAPTURE_SOURCE_KINDS,
  CLI_DEFAULT_MODEL,
  CLI_DEFAULT_TIMEOUT_MS,
} from "../types/config.js";
import type {
  CaptureSource,
  CaptureSourceKind,
  EmbeddingProviderType,
  ServerConfig,
} from "../types/config.js";

/** Topics init is allowed to ask about on the recommended path. */
export const INIT_KNOB_IDS = ["dataDir", "sources", "embedding", "more"] as const;
export type InitKnobId = (typeof INIT_KNOB_IDS)[number];

/**
 * Extra knobs asked only after More settings? Y.
 * To add one: field on MoreOverlay, id in MORE_SETTING_IDS (the array must
 * list every key), prompt copy, a case in the wizard walk, and a write in
 * applyInitOverlay. Do not inline a new question in init.ts.
 */
export interface MoreOverlay {
  cliModel?: string;
  cliTimeoutMs?: number;
}

export const MORE_SETTING_IDS = [
  "cliModel",
  "cliTimeoutMs",
] as const satisfies readonly (keyof MoreOverlay)[];
export type MoreSettingId = (typeof MORE_SETTING_IDS)[number];

type _EveryMoreKeyListed = Exclude<keyof MoreOverlay, MoreSettingId> extends never
  ? true
  : never;
const _everyMoreKeyListed: _EveryMoreKeyListed = true;
void _everyMoreKeyListed;

/**
 * Overlay init is allowed to write. Not Partial<ServerConfig> — that type is
 * shallow and would accept storage.provider / embedding.ann / a full provider swap.
 */
export interface InitOverlay extends MoreOverlay {
  sources?: CaptureSource[];
  embeddingProvider?: EmbeddingProviderType | null;
}

export function applyInitOverlay(
  base: ServerConfig,
  overlay: InitOverlay,
): ServerConfig {
  const next: ServerConfig = {
    ...base,
    embedding: { ...base.embedding },
    intelligence: { ...base.intelligence },
    sources: [...base.sources],
  };
  if (overlay.sources !== undefined) next.sources = overlay.sources;
  if (overlay.embeddingProvider !== undefined) {
    next.embedding = { ...next.embedding, provider: overlay.embeddingProvider };
  }
  // MORE_SETTING_IDS write path. Group by config section as extras grow.
  if (overlay.cliModel !== undefined || overlay.cliTimeoutMs !== undefined) {
    const cli = { ...base.intelligence.cli };
    if (overlay.cliModel !== undefined) cli.model = overlay.cliModel;
    if (overlay.cliTimeoutMs !== undefined) cli.timeout_ms = overlay.cliTimeoutMs;
    next.intelligence = { ...next.intelligence, cli };
  }
  return next;
}

/** Synthetic paths for docs and tests — never a real machine fingerprint. */
export const INIT_SYNTHETIC = {
  claudeHome: "~/.claude",
  cursorHome: "~/.cursor",
  cwd: "C:\\dev\\app",
  personalDir: "C:\\Users\\alex\\.factmem-personal",
  workDir: "C:\\Users\\alex\\.factmem-work",
} as const;

/** Copy — never return DEFAULT_CONFIG.sources by reference. */
export function silentSources(): CaptureSource[] {
  return [...DEFAULT_CONFIG.sources];
}

export function silentEmbeddingProvider(): EmbeddingProviderType | null {
  return DEFAULT_CONFIG.embedding.provider;
}

export function defaultHomeForKind(kind: CaptureSourceKind): string {
  return kind === "cursor" ? INIT_SYNTHETIC.cursorHome : INIT_SYNTHETIC.claudeHome;
}

function supportedKindsList(): string {
  return CAPTURE_SOURCE_KINDS.map((k) => `"${k}"`).join(" and ");
}

export const INIT_PROMPTS = {
  intro:
    "FactMem setup. Press Enter to accept the default in [brackets].\n" +
    "One directory is one memory. Another store is another directory.",
  dataDir: (shown: string) => `Data directory [${shown}]: `,
  capture:
    "Capture from a transcript source?  [N]\n" +
    "  N  no — pull stays off; capture_fact is how facts get in\n" +
    "  Y  yes — add one named source (claude-code or cursor)\n",
  kind:
    "Source kind  [claude-code]\n" +
    "  claude-code  Claude Code session JSONL\n" +
    "  cursor       Cursor Agent JSONL\n",
  unknownKind: () => `This version supports ${supportedKindsList()}.`,
  home: (shown: string) => `Client config dir (home)  [${shown}]: `,
  cwd: (shown: string) =>
    "Project directory (cwd) — required; a bare home walks every project group\n" +
    `  [${shown}]: `,
  cwdSkip:
    "cwd is required to add a source. Leaving pull off (sources stays empty).",
  embedding:
    "Semantic search  [off]\n" +
    '  off     keyword only — "shellfish" finds a shellfish fact, "food" does not\n' +
    "  ollama  local, no API key (needs Ollama running)\n" +
    "  voyage  hosted (needs VOYAGE_API_KEY)\n",
  more:
    "More settings?  [N]\n" +
    "  N  recommended — leave extra knobs at shipped defaults\n" +
    "  Y  set extra knobs (extraction model, per-stage timeout)\n",
  moreCliModel: (shown: string) => `Extraction model  [${shown}]: `,
  moreCliTimeout: (shown: string) => `Per-stage timeout in ms  [${shown}]: `,
  moreCliTimeoutInvalid:
    "Timeout must be a whole number of milliseconds greater than 0.",
  mixPullLogEvent:
    "Do not install log-event hooks on this store — both write the same rows.",
  forceHelp:
    "Replace config.json with shipped defaults (and, on a TTY, with the wizard answers). Does not merge with the previous file.",
  existingConfig:
    "already exists — left unchanged; use --force to reset. Prompts run only when writing config.json.",
  homeMissing: (stored: string) =>
    `Note: ${stored} does not exist yet. Pull will fail until the client has written it.`,
  projectGroupMissing: (home: string, cwd: string, encoded: string) =>
    `Note: no project group for cwd ${cwd} under ${home} (looked for ${encoded}).`,
  gitBashCwdHint: (cwd: string, encoded: string) =>
    `A POSIX-looking cwd ${cwd} on Windows is not the path Claude Code encodes (${encoded} vs ${INIT_SYNTHETIC.cwd} → C--dev-app). Store what the client used.`,
  captureDeclined:
    "Capture: pull is off (you said no). capture_fact is how facts get in.",
} as const;

export { CLI_DEFAULT_MODEL, CLI_DEFAULT_TIMEOUT_MS };
