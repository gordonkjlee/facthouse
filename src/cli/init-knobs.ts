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
  HTTP_DEFAULT_BASE_URL,
  HTTP_WELL_KNOWN_BASE_URLS,
  type IntelligenceConfig,
  type IntelligenceStageName,
  type StageOnFail,
} from "../types/config.js";
import type {
  CaptureSource,
  CaptureSourceKind,
  EmbeddingProviderType,
  ServerConfig,
} from "../types/config.js";
import { CLI_NAME } from "../identity.js";
import { defaultServerConfig, mergeConfig } from "../config.js";
import { httpBaseUrlOf, httpIsOptedIn, httpModelOf } from "../intelligence/http.js";
import {
  DEFAULT_HTTP_STAGES,
  resolveStageOnFail,
  resolveStageProviderType,
} from "../intelligence/stage-router.js";

/** Topics init is allowed to ask about on the recommended path. */
export const INIT_KNOB_IDS = ["dataDir", "sources", "embedding", "more"] as const;
export type InitKnobId = (typeof INIT_KNOB_IDS)[number];

/**
 * Extra knobs asked only after More settings? Y.
 * To add one: field on MoreOverlay, id in MORE_SETTING_IDS (the array must
 * list every key), prompt copy, a case in the wizard walk, and a write in
 * applyMoreOverlayToIntelligence. Do not inline a new question in init.ts.
 */
export interface MoreOverlay {
  cliModel?: string;
  cliTimeoutMs?: number;
  /** Y on local OpenAI-compat extract. */
  httpExtract?: boolean;
  httpBaseUrl?: string;
  httpModel?: string;
  httpExtractOnFail?: StageOnFail;
}

export const MORE_SETTING_IDS = [
  "cliModel",
  "cliTimeoutMs",
  "httpExtract",
  "httpBaseUrl",
  "httpModel",
  "httpExtractOnFail",
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

export type OverlayWriteMode = "defaults" | "patch";

/** JSON paths actually written, for settingsWrote and tests. */
export type OverlayWrittenPath =
  | "intelligence.cli.model"
  | "intelligence.cli.timeout_ms"
  | "intelligence.http.base_url"
  | "intelligence.http.model"
  | "intelligence.stages.extract.provider"
  | "intelligence.stages.extract.on_fail"
  | "intelligence.stages.summarise.provider"
  | "intelligence.stages.reconcile.provider"
  | "intelligence.stages.supersede.provider";

export interface MoreShown {
  cliModel: string;
  cliTimeoutMs: number;
  httpExtract: boolean;
  httpBaseUrl: string;
  httpModel: string;
  httpExtractOnFail: StageOnFail;
}

/** Init More walk only. Enable-default on_fail is cli, not resolved CLI none. */
export const SHIPPED_MORE_SHOWN: MoreShown = {
  cliModel: CLI_DEFAULT_MODEL,
  cliTimeoutMs: CLI_DEFAULT_TIMEOUT_MS,
  httpExtract: false,
  httpBaseUrl: HTTP_DEFAULT_BASE_URL,
  httpModel: "",
  httpExtractOnFail: "cli",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function ensureObj(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = asRecord(parent[key]);
  if (existing) return existing;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function materialiseDefaultStages(
  extractProvider: "http" | "cli",
): Record<string, unknown> {
  const stages: Record<string, unknown> = {};
  for (const [name, provider] of Object.entries(DEFAULT_HTTP_STAGES) as Array<
    [IntelligenceStageName, "http" | "cli"]
  >) {
    stages[name] = { provider: name === "extract" ? extractProvider : provider };
  }
  return stages;
}

const STAGE_PROVIDER_PATH: Record<
  IntelligenceStageName,
  OverlayWrittenPath
> = {
  extract: "intelligence.stages.extract.provider",
  summarise: "intelligence.stages.summarise.provider",
  reconcile: "intelligence.stages.reconcile.provider",
  supersede: "intelligence.stages.supersede.provider",
};

function writeMaterialisedStages(
  working: Record<string, unknown>,
  extractProvider: "http" | "cli",
  written: OverlayWrittenPath[],
): Record<string, unknown> {
  const stages = materialiseDefaultStages(extractProvider);
  working.stages = stages;
  for (const name of Object.keys(DEFAULT_HTTP_STAGES) as IntelligenceStageName[]) {
    written.push(STAGE_PROVIDER_PATH[name]);
  }
  return asRecord(stages)!;
}

function writeHttpField(
  working: Record<string, unknown>,
  overlay: MoreOverlay,
  written: OverlayWrittenPath[],
): Record<string, unknown> {
  const http = ensureObj(working, "http");
  if (overlay.httpBaseUrl !== undefined) {
    http.base_url = overlay.httpBaseUrl;
    written.push("intelligence.http.base_url");
  }
  if (overlay.httpModel !== undefined) {
    http.model = overlay.httpModel;
    written.push("intelligence.http.model");
  }
  return http;
}

function persistUrlIfNotOptedIn(
  working: Record<string, unknown>,
  overlay: MoreOverlay,
  written: OverlayWrittenPath[],
): void {
  if (httpIsOptedIn(working as { http?: { model?: string; base_url?: string }; provider?: string })) {
    return;
  }
  const http = ensureObj(working, "http");
  http.base_url = overlay.httpBaseUrl ?? HTTP_DEFAULT_BASE_URL;
  written.push("intelligence.http.base_url");
}

function setExtractProvider(
  working: Record<string, unknown>,
  provider: "http" | "cli",
  written: OverlayWrittenPath[],
): Record<string, unknown> {
  const stages = ensureObj(working, "stages");
  const extract = ensureObj(stages, "extract");
  if (extract.provider !== provider) {
    extract.provider = provider;
    written.push("intelligence.stages.extract.provider");
  } else if (!written.includes("intelligence.stages.extract.provider")) {
    written.push("intelligence.stages.extract.provider");
  }
  return extract;
}

function applyHttpEnable(
  working: Record<string, unknown>,
  overlay: MoreOverlay,
  mode: OverlayWriteMode,
  original: Record<string, unknown> | undefined,
  written: OverlayWrittenPath[],
): void {
  const extract = setExtractProvider(working, "http", written);
  writeHttpField(working, overlay, written);
  persistUrlIfNotOptedIn(working, overlay, written);
  const existingOnFail = asRecord(asRecord(original?.stages)?.extract)?.on_fail;
  if (overlay.httpExtractOnFail !== undefined) {
    extract.on_fail = overlay.httpExtractOnFail;
    written.push("intelligence.stages.extract.on_fail");
  } else if (
    mode === "defaults" ||
    (mode === "patch" && existingOnFail === undefined)
  ) {
    extract.on_fail = "cli";
    written.push("intelligence.stages.extract.on_fail");
  }
}

/**
 * The only More write path. Init uses mode "defaults"; settings uses "patch".
 * Predicates use mergeConfig + resolveStage*(..., {}), never process.env.
 */
export function applyMoreOverlayToIntelligence(
  intel: Record<string, unknown> | undefined,
  overlay: MoreOverlay,
  mode: OverlayWriteMode,
): { intel: Record<string, unknown> | undefined; written: OverlayWrittenPath[] } {
  const written: OverlayWrittenPath[] = [];
  const working: Record<string, unknown> = intel ? structuredClone(intel) : {};
  const merged = mergeConfig(
    defaultServerConfig().intelligence,
    working,
  ) as IntelligenceConfig;
  const alreadyExtractHttp =
    resolveStageProviderType(merged, "extract", {}) === "http";
  const omittedMap = Object.keys(asRecord(intel?.stages) ?? {}).length === 0;

  if (overlay.cliModel !== undefined || overlay.cliTimeoutMs !== undefined) {
    const cli = ensureObj(working, "cli");
    if (overlay.cliModel !== undefined) {
      cli.model = overlay.cliModel;
      written.push("intelligence.cli.model");
    }
    if (overlay.cliTimeoutMs !== undefined) {
      cli.timeout_ms = overlay.cliTimeoutMs;
      written.push("intelligence.cli.timeout_ms");
    }
  }

  if (mode === "defaults") {
    if (overlay.httpExtract) {
      applyHttpEnable(working, overlay, mode, intel, written);
    }
  } else if (overlay.httpExtract === true) {
    if (!alreadyExtractHttp) {
      applyHttpEnable(working, overlay, mode, intel, written);
    } else {
      const setUrl = overlay.httpBaseUrl !== undefined;
      const setModel = overlay.httpModel !== undefined;
      const setOnFail = overlay.httpExtractOnFail !== undefined;
      if (setUrl || setModel || setOnFail) {
        writeHttpField(working, overlay, written);
        if (setOnFail) {
          if (omittedMap) {
            const stages = writeMaterialisedStages(working, "http", written);
            const extract = ensureObj(stages, "extract");
            extract.on_fail = overlay.httpExtractOnFail;
            written.push("intelligence.stages.extract.on_fail");
          } else {
            const extract = ensureObj(ensureObj(working, "stages"), "extract");
            if (extract.provider !== "http") {
              extract.provider = "http";
              written.push("intelligence.stages.extract.provider");
            }
            extract.on_fail = overlay.httpExtractOnFail;
            written.push("intelligence.stages.extract.on_fail");
          }
        }
      }
    }
  } else if (overlay.httpExtract === false && alreadyExtractHttp) {
    const listedExtractHttp =
      asRecord(asRecord(intel?.stages)?.extract)?.provider === "http";
    if (listedExtractHttp) {
      const extract = setExtractProvider(working, "cli", written);
      void extract;
    } else if (omittedMap) {
      writeMaterialisedStages(working, "cli", written);
    }
  }

  if (written.length === 0) return { intel, written };
  return { intel: working, written };
}

export function patchConfigDocument(
  doc: Record<string, unknown>,
  overlay: InitOverlay,
): { next: Record<string, unknown>; written: OverlayWrittenPath[] } {
  const more: MoreOverlay = {};
  if (overlay.cliModel !== undefined) more.cliModel = overlay.cliModel;
  if (overlay.cliTimeoutMs !== undefined) more.cliTimeoutMs = overlay.cliTimeoutMs;
  if (overlay.httpExtract !== undefined) more.httpExtract = overlay.httpExtract;
  if (overlay.httpBaseUrl !== undefined) more.httpBaseUrl = overlay.httpBaseUrl;
  if (overlay.httpModel !== undefined) more.httpModel = overlay.httpModel;
  if (overlay.httpExtractOnFail !== undefined) {
    more.httpExtractOnFail = overlay.httpExtractOnFail;
  }

  const next = structuredClone(doc);
  const { intel, written } = applyMoreOverlayToIntelligence(
    asRecord(next.intelligence),
    more,
    "patch",
  );
  if (written.length === 0) return { next, written };
  if (intel === undefined) {
    delete next.intelligence;
  } else {
    next.intelligence = intel;
  }
  return { next, written };
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
  const { intel } = applyMoreOverlayToIntelligence(
    next.intelligence as unknown as Record<string, unknown>,
    overlay,
    "defaults",
  );
  if (intel) {
    next.intelligence = intel as unknown as IntelligenceConfig;
  }
  return next;
}

export function moreShownFromConfig(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = {},
): MoreShown {
  const shown: MoreShown = {
    cliModel: config.intelligence.cli?.model ?? CLI_DEFAULT_MODEL,
    cliTimeoutMs: config.intelligence.cli?.timeout_ms ?? CLI_DEFAULT_TIMEOUT_MS,
    httpExtract:
      resolveStageProviderType(config.intelligence, "extract", env) === "http",
    httpBaseUrl: httpBaseUrlOf(config.intelligence.http),
    httpModel: httpModelOf(config.intelligence.http) ?? "",
    httpExtractOnFail: resolveStageOnFail(config.intelligence, "extract", env),
  };
  return shown;
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
    "  Y  set extra knobs (CLI model, timeout, optional local extract)\n",
  moreCliModel: (shown: string) => `Extraction model  [${shown}]: `,
  moreCliTimeout: (shown: string) => `Per-stage timeout in ms  [${shown}]: `,
  moreCliTimeoutInvalid:
    "Timeout must be a whole number of milliseconds greater than 0.",
  moreHttpExtract: (shownYn: "Y" | "N") =>
    `Local extract on an OpenAI-compatible host?  [${shownYn}]\n` +
    "  N  no — extract stays on the Claude CLI\n" +
    "  Y  yes — Ollama / LM Studio / vLLM / llama.cpp (not embeddings)\n",
  moreHttpBaseUrl: (shown: string) =>
    `Host URL  [${shown}]\n` +
    HTTP_WELL_KNOWN_BASE_URLS.map((row) => `  ${row.host}  ${row.base_url}`).join(
      "\n",
    ) +
    "\n",
  moreHttpModel: (shown: string, listed: string[]) =>
    listed.length > 0
      ? `Chat model  [${shown || listed[0]}]\n  Host lists: ${listed.join(", ")}\n`
      : `Chat model  [${shown || "leave blank to use a unique chat model on the host"}]: `,
  moreHttpOnFail: (shown: string) =>
    `If local extract cannot run?  [${shown}]\n` +
    "  cli   retry on the Claude CLI (counts against the CLI token budget)\n" +
    "  none  hold the watermark; do not guess\n" +
    "  http  retry on HTTP (only useful when extract is the CLI)\n",
  moreHttpOnFailInvalid: "Use cli, none, or http.",
  mixPullLogEvent:
    "Do not install log-event hooks on this store — both write the same rows.",
  forceHelp:
    "Replace config.json with shipped defaults (and, on a TTY, with the wizard answers). Does not merge with the previous file.",
  existingConfig:
    `already exists — left unchanged; run ${CLI_NAME} settings to change extra knobs, or --force to reset. Prompts run only when writing config.json.`,
  homeMissing: (stored: string) =>
    `Note: ${stored} does not exist yet. Pull will fail until the client has written it.`,
  projectGroupMissing: (home: string, cwd: string, encoded: string) =>
    `Note: no project group for cwd ${cwd} under ${home} (looked for ${encoded}).`,
  gitBashCwdHint: (cwd: string, encoded: string) =>
    `A POSIX-looking cwd ${cwd} on Windows is not the path Claude Code encodes (${encoded} vs ${INIT_SYNTHETIC.cwd} → C--dev-app). Store what the client used.`,
  captureDeclined:
    "Capture: pull is off (you said no). capture_fact is how facts get in.",
} as const;

export const SETTINGS_PROMPTS = {
  intro: (dir: string) =>
    `FactMem settings for ${dir}. Press Enter to keep the current value.`,
  missing: (dir: string) =>
    `No config.json at ${dir}. Run ${CLI_NAME} init first (this command does not create a store).`,
  malformed:
    "config.json is malformed. Fix or restore it; this command will not replace it.",
  notObject:
    "config.json must be a JSON object. This command will not replace it.",
  noChanges: "No changes.",
  wrote: (paths: readonly OverlayWrittenPath[], configPath: string) =>
    `Wrote ${paths.join(", ")} in ${configPath}. Reload the MCP server for routing to change.`,
  needTty:
    "No terminal. Re-run on a TTY to change knobs, or pass --json to print them.",
  eacces: (configPath: string) =>
    `Could not write ${configPath} (permission denied).`,
} as const;

export { CLI_DEFAULT_MODEL, CLI_DEFAULT_TIMEOUT_MS, HTTP_DEFAULT_BASE_URL };
