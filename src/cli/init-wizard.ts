/**
 * TTY walk-through for `openmemory init`.
 *
 * Prompts live in init-knobs.ts. This file only asks them. Silent / --yes
 * never constructs readline and never calls question().
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILENAME } from "../config.js";
import { expandTilde, resolveUserPath } from "../paths.js";
import {
  isCaptureSourceKind,
  type CaptureSourceKind,
} from "../types/config.js";
import {
  encodeCursorProjectDir,
  encodeProjectDir,
} from "../sources/resolve.js";
import {
  CLI_DEFAULT_MODEL,
  CLI_DEFAULT_TIMEOUT_MS,
  INIT_PROMPTS,
  MORE_SETTING_IDS,
  defaultHomeForKind,
  type InitOverlay,
} from "./init-knobs.js";

export const MAX_INIT_QUESTIONS = 20;

export interface InitIo {
  isTTY: boolean;
  /** Raw line, no trim inside the interface. Wizard trims. */
  question(prompt: string): Promise<string>;
  /** Wizard-owned copy: intro, skip notes, existence warnings. */
  write(text: string): void;
}

export function bindInitIo(rl: {
  question(prompt: string): Promise<string>;
}): InitIo {
  return {
    isTTY: true,
    question: (p) => rl.question(p),
    write: (t) => {
      process.stdout.write(t.endsWith("\n") ? t : `${t}\n`);
    },
  };
}

export function silentInitIo(): InitIo {
  return {
    isTTY: false,
    question: async () => {
      throw new Error("silentInitIo.question must not be called");
    },
    write: () => {},
  };
}

export interface InitWizardDeps {
  cwd: () => string;
  exists: (absPath: string) => boolean;
  platform: () => NodeJS.Platform;
}

export const defaultInitWizardDeps: InitWizardDeps = {
  cwd: () => process.cwd(),
  exists: existsSync,
  platform: () => process.platform,
};

export interface InitWizardSeed {
  dataDir: string;
  dataDirLocked: boolean;
  force: boolean;
}

export interface InitWizardResult {
  dataDir: string;
  overlay: InitOverlay;
  writeConfig: boolean;
  captureAskedAndEmpty: boolean;
}

export function willAskQuestions(seed: InitWizardSeed, configExists: boolean): boolean {
  if (!seed.dataDirLocked) return true;
  return !configExists || seed.force;
}

export function isInteractiveInit(opts: {
  stdinIsTTY: boolean;
  yes: boolean;
  seed: InitWizardSeed;
  configExists: boolean;
}): boolean {
  if (!opts.stdinIsTTY || opts.yes) return false;
  return willAskQuestions(opts.seed, opts.configExists);
}

export function isCrossPlatformAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

export function storeCwdAnswer(trimmed: string, processCwd: string): string | "skip" {
  if (trimmed === "-" || trimmed.toLowerCase() === "skip") return "skip";
  if (trimmed === "") return processCwd;
  if (trimmed === "~" || trimmed.startsWith("~/")) return expandTilde(trimmed);
  if (isCrossPlatformAbsolute(trimmed)) return trimmed;
  return path.resolve(processCwd, trimmed);
}

export function shouldHintGitBashCwd(
  stored: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32" && stored.startsWith("/");
}

function yesNo(raw: string): "yes" | "no" | "retry" {
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "n" || t === "no") return "no";
  if (t === "y" || t === "yes") return "yes";
  return "retry";
}

function parseTimeoutMs(raw: string): number | "empty" | "invalid" {
  const t = raw.trim();
  if (t === "") return "empty";
  if (!/^[0-9]+$/.test(t)) return "invalid";
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n <= 0) return "invalid";
  return n;
}

async function askCapture(
  io: InitIo,
  deps: InitWizardDeps,
  overlay: InitOverlay,
): Promise<boolean> {
  for (;;) {
    const yn = yesNo(await io.question(INIT_PROMPTS.capture));
    if (yn === "retry") continue;
    if (yn === "no") return true;
    break;
  }

  let kind: CaptureSourceKind;
  for (;;) {
    const raw = (await io.question(INIT_PROMPTS.kind)).trim().toLowerCase();
    const chosen = raw === "" ? "claude-code" : raw;
    if (isCaptureSourceKind(chosen)) {
      kind = chosen;
      break;
    }
    io.write(INIT_PROMPTS.unknownKind());
  }

  const homeDefault = defaultHomeForKind(kind);
  const homeRaw = (await io.question(INIT_PROMPTS.home(homeDefault))).trim();
  const home = homeRaw === "" ? homeDefault : homeRaw;
  const homeAbs = resolveUserPath(home);
  const homeOk = deps.exists(homeAbs);
  if (!homeOk) io.write(INIT_PROMPTS.homeMissing(home));

  const cwdRaw = (await io.question(INIT_PROMPTS.cwd(deps.cwd()))).trim();
  const stored = storeCwdAnswer(cwdRaw, deps.cwd());
  if (stored === "skip") {
    io.write(INIT_PROMPTS.cwdSkip);
    return true;
  }

  if (shouldHintGitBashCwd(stored, deps.platform())) {
    io.write(INIT_PROMPTS.gitBashCwdHint(stored, encodeProjectDir(stored)));
  }

  if (homeOk) {
    const encoded =
      kind === "cursor" ? encodeCursorProjectDir(stored) : encodeProjectDir(stored);
    const groupPath = path.join(homeAbs, "projects", encoded);
    if (!deps.exists(groupPath)) {
      io.write(INIT_PROMPTS.projectGroupMissing(home, stored, encoded));
    }
  }

  overlay.sources = [{ kind, home, cwd: stored }];
  return false;
}

async function askSearch(io: InitIo, overlay: InitOverlay): Promise<void> {
  for (;;) {
    const raw = (await io.question(INIT_PROMPTS.embedding)).trim().toLowerCase();
    if (raw === "" || raw === "off" || raw === "none" || raw === "n") return;
    if (raw === "ollama") {
      overlay.embeddingProvider = "ollama";
      return;
    }
    if (raw === "voyage") {
      overlay.embeddingProvider = "voyage";
      return;
    }
  }
}

/**
 * Extra knobs after More settings? Y.
 * Walk MORE_SETTING_IDS — add a case here, not a question in index.ts.
 * Enter on a knob omits it and continues; it must not skip later extras.
 */
async function askMoreSettings(io: InitIo, overlay: InitOverlay): Promise<void> {
  for (;;) {
    const yn = yesNo(await io.question(INIT_PROMPTS.more));
    if (yn === "retry") continue;
    if (yn === "no") return;
    break;
  }

  for (const id of MORE_SETTING_IDS) {
    switch (id) {
      case "cliModel": {
        const modelRaw = (
          await io.question(INIT_PROMPTS.moreCliModel(CLI_DEFAULT_MODEL))
        ).trim();
        if (modelRaw !== "") overlay.cliModel = modelRaw;
        break;
      }
      case "cliTimeoutMs": {
        for (;;) {
          const parsed = parseTimeoutMs(
            await io.question(
              INIT_PROMPTS.moreCliTimeout(String(CLI_DEFAULT_TIMEOUT_MS)),
            ),
          );
          if (parsed === "empty") break;
          if (parsed === "invalid") {
            io.write(INIT_PROMPTS.moreCliTimeoutInvalid);
            continue;
          }
          overlay.cliTimeoutMs = parsed;
          break;
        }
        break;
      }
      default: {
        const _exhaustive: never = id;
        void _exhaustive;
      }
    }
  }
}

export async function collectInitAnswers(
  io: InitIo,
  seed: InitWizardSeed,
  deps: InitWizardDeps = defaultInitWizardDeps,
): Promise<InitWizardResult> {
  const seedExists = deps.exists(path.join(seed.dataDir, CONFIG_FILENAME));

  if (!io.isTTY) {
    return {
      dataDir: seed.dataDir,
      overlay: {},
      writeConfig: !seedExists || seed.force,
      captureAskedAndEmpty: false,
    };
  }

  if (willAskQuestions(seed, seedExists)) io.write(INIT_PROMPTS.intro);

  let dataDir = seed.dataDir;
  if (!seed.dataDirLocked) {
    const raw = (await io.question(INIT_PROMPTS.dataDir(seed.dataDir))).trim();
    dataDir = raw === "" ? seed.dataDir : resolveUserPath(raw);
  }

  const chosenExists = deps.exists(path.join(dataDir, CONFIG_FILENAME));
  const willWrite = !chosenExists || seed.force;
  if (!willWrite) {
    return {
      dataDir,
      overlay: {},
      writeConfig: false,
      captureAskedAndEmpty: false,
    };
  }

  const overlay: InitOverlay = {};
  const captureEmpty = await askCapture(io, deps, overlay);
  await askSearch(io, overlay);
  await askMoreSettings(io, overlay);

  return {
    dataDir,
    overlay,
    writeConfig: true,
    captureAskedAndEmpty: captureEmpty,
  };
}
