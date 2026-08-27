/**
 * The only knobs `openmemory init` is allowed to ask about.
 *
 * Silent values are expressions of DEFAULT_CONFIG / defaultDataDir(), not
 * copied literals. Prompt copy lives here so the wizard (later) and tests
 * cannot grow a second vocabulary.
 */

import { DEFAULT_CONFIG, CAPTURE_SOURCE_KINDS } from "../types/config.js";
import type {
  CaptureSource,
  CaptureSourceKind,
  EmbeddingProviderType,
  ServerConfig,
} from "../types/config.js";

/** The only knobs init is allowed to ask about. */
export const INIT_KNOB_IDS = ["dataDir", "sources", "embedding"] as const;
export type InitKnobId = (typeof INIT_KNOB_IDS)[number];

/**
 * Overlay init is allowed to write. Not Partial<ServerConfig> — that type is
 * shallow and would accept storage.provider / intelligence.
 */
export interface InitOverlay {
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
    sources: [...base.sources],
  };
  if (overlay.sources !== undefined) next.sources = overlay.sources;
  if (overlay.embeddingProvider !== undefined) {
    next.embedding = { ...next.embedding, provider: overlay.embeddingProvider };
  }
  return next;
}

/** Synthetic paths for docs and tests — never a real machine fingerprint. */
export const INIT_SYNTHETIC = {
  claudeHome: "~/.claude",
  cursorHome: "~/.cursor",
  cwd: "C:\\dev\\app",
  personalDir: "C:\\Users\\alex\\.openmemory-personal",
  workDir: "C:\\Users\\alex\\.openmemory-work",
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
    "OpenMemory setup. Press Enter to accept the default in [brackets].\n" +
    "One directory is one memory. A second brain is a second directory.",
  dataDir: (shown: string) => `Data directory [${shown}]:`,
  capture:
    "Capture from a transcript source?  [N]\n" +
    "  N  no — pull stays off; capture_fact is how facts get in\n" +
    "  Y  yes — add one named source (claude-code or cursor)",
  kind:
    "Source kind  [claude-code]\n" +
    "  claude-code  Claude Code session JSONL\n" +
    "  cursor       Cursor Agent JSONL",
  unknownKind: () => `This version supports ${supportedKindsList()}.`,
  home: (shown: string) => `Client config dir (home)  [${shown}]:`,
  cwd: (shown: string) =>
    "Project directory (cwd) — required; a bare home walks every project group\n" +
    `  [${shown}]:`,
  cwdSkip:
    "cwd is required to add a source. Leaving pull off (sources stays empty).",
  embedding:
    "Semantic search  [off]\n" +
    '  off     keyword only — "shellfish" finds a shellfish fact, "food" does not\n' +
    "  ollama  local, no API key (needs Ollama running)\n" +
    "  voyage  hosted (needs VOYAGE_API_KEY)",
  mixPullLogEvent:
    "Do not install log-event hooks on this store — both write the same rows.",
  forceHelp:
    "Replace config.json with shipped defaults (and, on a TTY, with the capture/search answers). Does not merge with the previous file.",
  existingConfig:
    "already exists — left unchanged; use --force to reset. Capture and search prompts run only when writing config.json.",
} as const;
