/**
 * The only knobs `facthouse init` is allowed to ask about.
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
  CLI_DEFAULT_INTEGRATE_MODEL,
  CLI_DEFAULT_TIMEOUT_MS,
  CLI_HISTORIC_TIMEOUT_MS,
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
import { CLI_NAME, cliDataArg, pathFreeCli } from "../identity.js";
import { EXTRACT_CAP_EVENTS } from "../intelligence/steps.js";
import { defaultServerConfig, mergeConfig } from "../config.js";
import { httpBaseUrlOf, httpIsOptedIn, httpModelOf } from "../intelligence/http.js";
import {
  DEFAULT_HTTP_STAGES,
  resolveStageOnFail,
  resolveStageProviderType,
} from "../intelligence/stage-router.js";

/** Topics init is allowed to ask about on the recommended path. */
export const INIT_KNOB_IDS = ["dataDir", "sources", "more"] as const;
export type InitKnobId = (typeof INIT_KNOB_IDS)[number];

/**
 * Extra knobs asked only after More settings? Y.
 * To add one: field on MoreOverlay, id in MORE_SETTING_IDS (the array must
 * list every key), prompt copy, a case in the wizard walk, and a write in
 * applyMoreOverlayToIntelligence. Do not inline a new question in init.ts.
 */
export interface MoreOverlay {
  cliModel?: string;
  /** CLI model for the integrate step. Omit to use cliModel. */
  cliIntegrateModel?: string;
  cliTimeoutMs?: number;
  /** Y on local OpenAI-compat extract. */
  httpExtract?: boolean;
  httpBaseUrl?: string;
  httpModel?: string;
  httpExtractOnFail?: StageOnFail;
}

export const MORE_SETTING_IDS = [
  "cliModel",
  "cliIntegrateModel",
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
  | "intelligence.cli.integrate_model"
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
  cliIntegrateModel: string;
  cliTimeoutMs: number;
  httpExtract: boolean;
  httpBaseUrl: string;
  httpModel: string;
  httpExtractOnFail: StageOnFail;
}

/** Init More walk only. Enable-default on_fail is cli, not resolved CLI none. */
export const SHIPPED_MORE_SHOWN: MoreShown = {
  cliModel: CLI_DEFAULT_MODEL,
  cliIntegrateModel: CLI_DEFAULT_INTEGRATE_MODEL,
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

  // The pre-vocabulary key is read for compatibility but never kept: any
  // write through this path migrates it, even an Enter-through settings walk.
  const legacyCli = asRecord(working.cli);
  if (legacyCli && legacyCli.graduate_model !== undefined) {
    if (legacyCli.integrate_model === undefined) {
      legacyCli.integrate_model = legacyCli.graduate_model;
    }
    delete legacyCli.graduate_model;
    written.push("intelligence.cli.integrate_model");
  }

  if (
    overlay.cliModel !== undefined ||
    overlay.cliIntegrateModel !== undefined ||
    overlay.cliTimeoutMs !== undefined
  ) {
    const cli = ensureObj(working, "cli");
    if (overlay.cliModel !== undefined) {
      cli.model = overlay.cliModel;
      written.push("intelligence.cli.model");
    }
    if (overlay.cliIntegrateModel !== undefined) {
      const extract =
        (
          overlay.cliModel ??
          (typeof cli.model === "string" ? cli.model : undefined) ??
          CLI_DEFAULT_MODEL
        ).trim() || CLI_DEFAULT_MODEL;
      if (overlay.cliIntegrateModel.trim() === extract) {
        if (cli.integrate_model !== undefined) {
          delete cli.integrate_model;
          written.push("intelligence.cli.integrate_model");
        }
      } else {
        cli.integrate_model = overlay.cliIntegrateModel;
        written.push("intelligence.cli.integrate_model");
      }
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
  if (overlay.cliIntegrateModel !== undefined) {
    more.cliIntegrateModel = overlay.cliIntegrateModel;
  }
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
    cliIntegrateModel:
      config.intelligence.cli?.integrate_model ?? CLI_DEFAULT_INTEGRATE_MODEL,
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
  personalDir: "C:\\Users\\alex\\.facthouse-personal",
  workDir: "C:\\Users\\alex\\.facthouse-work",
} as const;

/** Copy — never return DEFAULT_CONFIG.sources by reference. */
export function silentSources(): CaptureSource[] {
  return [...DEFAULT_CONFIG.sources];
}

export function silentEmbeddingProvider(): EmbeddingProviderType | null {
  return DEFAULT_CONFIG.embedding.provider;
}

export function defaultHomeForKind(
  kind: CaptureSourceKind,
  env: NodeJS.ProcessEnv = {},
): string {
  if (kind === "cursor") return INIT_SYNTHETIC.cursorHome;
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) return fromEnv;
  return INIT_SYNTHETIC.claudeHome;
}

function supportedKindsList(): string {
  return CAPTURE_SOURCE_KINDS.map((k) => `"${k}"`).join(" and ");
}

/** First line of an INIT_PROMPTS string, before the default in brackets. */
export function promptLabel(prompt: string): string {
  const first = prompt.split("\n")[0] ?? prompt;
  return first.split("  [")[0]!.replace(/\?$/, "").trim();
}

/** Isolation unit. Intro, done card, and README § Another store print this. */
const STORE_DIR =
  "The store is this directory. Clients share it by using the same path. " +
  "A second store is a second directory, not a second install.";

export const INIT_PROMPTS = {
  storeDir: STORE_DIR,
  intro:
    "Facthouse setup. Press Enter to accept the default in [brackets].\n" +
    STORE_DIR,
  dataDir: (shown: string) => `Data directory [${shown}]: `,
  capture:
    "How do conversations get in?\n" +
    "  copy    session logs on disk (Claude Code or Cursor)\n" +
    "  record  the assistant saves facts as you talk (Grok, Desktop, …)\n" +
    "  [copy]: ",
  kind:
    "Which client writes those logs?  [claude-code]\n" +
    "  claude-code  Claude Code\n" +
    "  cursor       Cursor\n" +
    "  [claude-code]: ",
  unknownKind: () => `This version supports ${supportedKindsList()}.`,
  home: (shown: string) =>
    `Where those logs live (client home, not the project)  [${shown}]: `,
  cwd: (shown: string) =>
    `Which project folder are the logs for?  [${shown}]: `,
  cwdSkip:
    "A project folder is required to add a source. Leaving copy off (sources stays empty).",
  notAPath:
    "That is not a directory path. Use C:/..., ~/..., or ./... (or Enter for the default).",
  embedding:
    "Semantic search  [off]\n" +
    '  off     keyword only — "shellfish" finds a shellfish fact, "food" does not\n' +
    "  ollama  local, no API key (needs Ollama running)\n" +
    "  voyage  hosted (needs VOYAGE_API_KEY)\n" +
    "  [off]: ",
  more:
    "More settings?  [N]\n" +
    "  N  recommended — leave extra knobs at shipped defaults\n" +
    "  Y  semantic search, models, optional local extract\n" +
    "  [N]: ",
  moreCliModel: (shown: string) => `Extract model  [${shown}]: `,
  moreCliIntegrateModel: (shown: string) => `Integrate model  [${shown}]: `,
  moreCliTimeout: (shown: string) =>
    `Idle silence on the Claude CLI (ms)  [${shown}]: `,
  moreCliTimeoutInvalid:
    "Timeout must be a whole number of milliseconds greater than 0 (no pipe bytes before kill).",
  moreHttpExtract: (shownYn: "Y" | "N") =>
    `Local extract on an OpenAI-compatible host?  [${shownYn}]\n` +
    "  N  no — extract stays on the Claude CLI\n" +
    "  Y  yes — Ollama / LM Studio / vLLM / llama.cpp (not embeddings)\n" +
    `  [${shownYn}]: `,
  moreHttpBaseUrl: (shown: string) =>
    `Host URL  [${shown}]\n` +
    HTTP_WELL_KNOWN_BASE_URLS.map((row) => `  ${row.host}  ${row.base_url}`).join(
      "\n",
    ) +
    `\n  [${shown}]: `,
  moreHttpModel: (shown: string, listed: string[]) => {
    if (listed.length > 1) {
      const fallback = shown || "name one";
      return (
        `Local chat model  [${fallback}]\n` +
        `  Host lists: ${listed.join(", ")}\n` +
        `  [${fallback}]: `
      );
    }
    const fallback = shown || listed[0] || "blank if the host serves only one";
    return `Local chat model  [${fallback}]: `;
  },
  moreHttpOnFail: (shown: string) =>
    `If local extract cannot run?  [${shown}]\n` +
    "  cli   retry on the Claude CLI (counts against the CLI token budget)\n" +
    "  none  hold the watermark; do not guess\n" +
    "  http  retry on HTTP (only useful when extract is the CLI)\n" +
    `  [${shown}]: `,
  moreHttpOnFailInvalid: "Use cli, none, or http.",
  mixCopyRecord:
    "Do not install record hooks on this store — both write the same rows.",
  forceHelp:
    "Replace config.json with shipped defaults (and, on a TTY, with the wizard answers). Does not merge with the previous file.",
  existingConfig:
    `already exists — left unchanged; run ${CLI_NAME} settings to change extra knobs, or --force to reset. Prompts run only when writing config.json.`,
  configMalformed:
    "config.json is malformed. Fix or restore it, or pass --force to replace it.",
  homeMissing: (stored: string) =>
    `Note: ${stored} does not exist yet. Copy will fail until the client has written it.`,
  projectGroupMissing: (home: string, cwd: string, encoded: string) =>
    `Note: no project group for cwd ${cwd} under ${home} (looked for ${encoded}).`,
  gitBashCwdHint: (cwd: string, encoded: string) =>
    `A POSIX-looking cwd ${cwd} on Windows is not the path Claude Code encodes (${encoded} vs ${INIT_SYNTHETIC.cwd} → C--dev-app). Store what the client used.`,
  historicCopy:
    "Copy existing logs now?  [Y]\n" +
    "  Y  yes\n" +
    "  N  not now\n" +
    "  [Y]: ",
  historicExtract:
    "Extract and integrate now?  [all]\n" +
    "  all    every copied line (model calls; may take a while)\n" +
    "  7d     last 7 days (older lines are skipped)\n" +
    "  30d    last 30 days (older lines are skipped)\n" +
    "  <n>    oldest n lines\n" +
    "  N      not now\n" +
    "  [all]: ",
  copyingNow: "Copying transcripts…",
  copiedLines: (n: number) =>
    n === 0 ? "No new transcript lines." : `Copied ${n} line(s).`,
  extractingNow: (n: number) =>
    `Extracting and integrating ${n} line(s) (model calls). A quiet gap is idle silence, not the whole job dying. Progress prints as conversations finish.`,
  extractProgress: (done: number, total: number) =>
    `Examined ${done} of ${total} line(s)…`,
  extractTimedOut: (idleSeconds: number) =>
    `No output from the model for ${idleSeconds}s. That chunk was not examined and stays eligible.`,
  extractSkippedHeuristic:
    "Skipped extract — the heuristic does not read transcripts.",
  /** After the init offer ran extract + integrate. Same channel as the prompts. */
  integrated: (facts: number, remaining: number) =>
    remaining > 0
      ? `Integrated ${facts} fact(s). ${remaining} line(s) remain — ${CLI_NAME} consolidate --all takes the lot.`
      : `Integrated ${facts} fact(s).`,
  captureDeclined:
    `Capture: copy is off (record). capture_fact is how facts get in; a client hook can pipe into ${CLI_NAME} record.`,
  cwdSkipped:
    `Capture: copy is off — no cwd was given. capture_fact is how facts get in; re-run ${CLI_NAME} init --force on a terminal to name a source.`,
  /** The one sentence that says how a copy store starts. init prints it; README repeats it. */
  copyRecipe:
    `${CLI_NAME} init on a terminal, pick copy, set cwd. Init asks whether to copy existing logs, then whether to extract and integrate.`,
  copyNext: (dataDir?: string) => {
    const extra = dataDir ? ` --data ${cliDataArg(dataDir)}` : "";
    return (
      `Run ${CLI_NAME} consolidate${extra} ` +
      `(oldest ${EXTRACT_CAP_EVENTS} lines per run; --all takes the lot).`
    );
  },
  copyStorewide:
    "On a copy store, capture_fact is a correction for every MCP client, not only the one that writes JSONL.",
  webExisting:
    "config.json already exists — left unchanged; --web does not start a page. Run facthouse settings --web for extra knobs, or --force to reset.",
  mcpVsCli:
    "The MCP JSON starts the server via npx and does not need a global install. " +
    `npm install -g puts ${CLI_NAME} on PATH for init, settings, stats, and inspect. ` +
    `The same CLI without PATH is ${pathFreeCli("")} — pin the version; ` +
    "quote the package so PowerShell does not splat. " +
    "-p and -- stop an older global binary winning. " +
    `npx -y @facthouse/mcp with no -p / ${CLI_NAME} is the server; do not run it as a shell command for init, settings, or stats.`,
  /** Quick Start: MCP paste is not a shell install. */
  mcpPasteNoCli:
    `The MCP paste starts the server. It does not put ${CLI_NAME} on PATH. ` +
    "To inspect the file from a terminal, see CLI below.",
  mcpInstallClash:
    "If npm install -g fails because a command named mcp already exists, remove that leftover command and retry.",
  /** Quick Start after `npm install -g` + TTY init. */
  quickStartNext:
    "Press Enter to accept each default (copy = Claude Code or Cursor session logs on disk; type record if the assistant should save facts). " +
    "If you picked copy, init asks whether to copy existing logs, then whether to extract and integrate. " +
    "Init prints an MCP snippet — paste it into the client and restart.",
  /** MCP env does not apply to CLI or hooks. Do not write $FACTHOUSE_DATA (hang-safety). */
  mcpEnvNotCli:
    "FACTHOUSE_DATA on an MCP snippet applies only to that server process. " +
    `A terminal ${CLI_NAME} command needs --data, or FACTHOUSE_DATA in the environment that shell inherits. ` +
    "Hooks do not see mcp.json env.",
  shellNote:
    "These CLI commands work in bash, zsh, and PowerShell. Quote @facthouse/mcp in PowerShell. " +
    "Git Bash /c/... paths are not PowerShell; use C:/... and pass --data instead of cd or export. " +
    "In Git Bash, quote a backslash path or write C:/... — unquoted \\ is an escape. " +
    "~/ is expanded on every platform. WSL uses /mnt/c/....",
  webYesRefuse:
    "--yes does not start a local page. Re-run without --yes, or skip --web.",
  webListening: (url: string) =>
    `Open ${url}  (bound to 127.0.0.1; this process does not open a browser). Ctrl+C to cancel.`,
  webSaved: "Answers received. The terminal shows what was written. Reload the MCP server for routing to change.",
} as const;

export const SETTINGS_PROMPTS = {
  intro: (dir: string) =>
    `Facthouse settings for ${dir}. Press Enter to keep the current value.`,
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

export {
  CLI_DEFAULT_MODEL,
  CLI_DEFAULT_INTEGRATE_MODEL,
  CLI_DEFAULT_TIMEOUT_MS,
  CLI_HISTORIC_TIMEOUT_MS,
  HTTP_DEFAULT_BASE_URL,
};
