/**
 * `factmem settings` — merge More knobs into an existing config.json.
 *
 * Does not create a store, open a database, or reset the file. Missing or
 * malformed JSON is refused. `--json` / non-TTY dump and do not write.
 * `--web` serves a loopback page. Init `--yes` is not a settings flag.
 */

import path from "node:path";
import {
  CONFIG_FILENAME,
  ConfigDocumentError,
  defaultServerConfig,
  mergeConfig,
  readConfigDocument,
  writeConfigDocument,
} from "../config.js";
import type { ServerConfig } from "../types/config.js";
import {
  MORE_SETTING_IDS,
  SETTINGS_PROMPTS,
  moreShownFromConfig,
  patchConfigDocument,
  type MoreOverlay,
  type MoreShown,
  type OverlayWrittenPath,
} from "./init-knobs.js";
import {
  askMoreSettings,
  defaultInitWizardDeps,
  silentInitIo,
  type InitIo,
  type InitWizardDeps,
} from "./init-wizard.js";
import { collectSettingsWebAnswers } from "./web.js";

export interface RunSettingsOpts {
  dataDir: string;
  json: boolean;
  stdinIsTTY: boolean;
  web?: boolean;
  io?: InitIo;
  probeHttp?: InitWizardDeps["probeHttp"];
  readDocument?: (dir: string) => Record<string, unknown>;
  writeDocument?: (dir: string, doc: Record<string, unknown>) => void;
  stdout?: { write(chunk: string): void };
  stderr?: { write(chunk: string): void };
}

function moreDumpJson(shown: MoreShown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of MORE_SETTING_IDS) {
    switch (id) {
      case "cliModel":
        out.cliModel = shown.cliModel;
        break;
      case "cliGraduateModel":
        out.cliGraduateModel = shown.cliGraduateModel;
        break;
      case "cliTimeoutMs":
        out.cliTimeoutMs = shown.cliTimeoutMs;
        break;
      case "httpExtract":
        out.httpExtract = shown.httpExtract;
        break;
      case "httpBaseUrl":
        out.httpBaseUrl = shown.httpBaseUrl;
        break;
      case "httpModel":
        out.httpModel = shown.httpModel === "" ? null : shown.httpModel;
        break;
      case "httpExtractOnFail":
        out.httpExtractOnFail = shown.httpExtractOnFail;
        break;
      default: {
        const _exhaustive: never = id;
        void _exhaustive;
      }
    }
  }
  return out;
}

function moreDumpLines(shown: MoreShown): string[] {
  const lines: string[] = [];
  for (const id of MORE_SETTING_IDS) {
    switch (id) {
      case "cliModel":
        lines.push(`Model to extract facts from messages: ${shown.cliModel}`);
        break;
      case "cliGraduateModel":
        lines.push(`Model to update long-term knowledge: ${shown.cliGraduateModel}`);
        break;
      case "cliTimeoutMs":
        lines.push(`Per-stage timeout in ms: ${shown.cliTimeoutMs}`);
        break;
      case "httpExtract":
        lines.push(`Local extract: ${shown.httpExtract ? "yes" : "no"}`);
        break;
      case "httpBaseUrl":
        lines.push(`Host URL: ${shown.httpBaseUrl}`);
        break;
      case "httpModel":
        lines.push(`Local chat model: ${shown.httpModel || "(unset)"}`);
        break;
      case "httpExtractOnFail":
        lines.push(`Extract on-fail: ${shown.httpExtractOnFail}`);
        break;
      default: {
        const _exhaustive: never = id;
        void _exhaustive;
      }
    }
  }
  return lines;
}

function shownFromDocument(doc: Record<string, unknown>): MoreShown {
  const merged = mergeConfig(defaultServerConfig(), doc) as ServerConfig;
  return moreShownFromConfig(merged, {});
}

function writeLine(stream: { write(chunk: string): void }, text: string): void {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

export async function runSettings(opts: RunSettingsOpts): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const readDocument = opts.readDocument ?? readConfigDocument;
  const writeDocument = opts.writeDocument ?? writeConfigDocument;
  const configPath = path.join(opts.dataDir, CONFIG_FILENAME);

  let doc: Record<string, unknown>;
  try {
    doc = readDocument(opts.dataDir);
  } catch (err) {
    if (err instanceof ConfigDocumentError) {
      if (err.code === "missing") {
        writeLine(stderr, SETTINGS_PROMPTS.missing(opts.dataDir));
      } else if (err.code === "malformed") {
        writeLine(stderr, SETTINGS_PROMPTS.malformed);
      } else {
        writeLine(stderr, SETTINGS_PROMPTS.notObject);
      }
      return 1;
    }
    throw err;
  }

  const shown = shownFromDocument(doc);
  if (opts.web) {
    const overlay = await collectSettingsWebAnswers({ shown, stdout });
    return writeOverlay(opts, doc, overlay, stdout, stderr, configPath);
  }
  const dumpOnly = opts.json || !opts.stdinIsTTY;

  if (dumpOnly) {
    if (opts.json) {
      writeLine(
        stdout,
        JSON.stringify({ data_dir: opts.dataDir, more: moreDumpJson(shown) }, null, 2),
      );
    } else {
      for (const line of moreDumpLines(shown)) writeLine(stdout, line);
      writeLine(stdout, SETTINGS_PROMPTS.needTty);
    }
    return 0;
  }

  const io = opts.io ?? silentInitIo();
  writeLine(stdout, SETTINGS_PROMPTS.intro(opts.dataDir));
  const overlay: MoreOverlay = {};
  await askMoreSettings(io, overlay, {
    ...defaultInitWizardDeps,
    probeHttp: opts.probeHttp,
  }, { gate: false, shown });

  return writeOverlay(opts, doc, overlay, stdout, stderr, configPath);
}

async function writeOverlay(
  opts: RunSettingsOpts,
  doc: Record<string, unknown>,
  overlay: MoreOverlay,
  stdout: { write(chunk: string): void },
  stderr: { write(chunk: string): void },
  configPath: string,
): Promise<number> {
  const writeDocument = opts.writeDocument ?? writeConfigDocument;
  const { next, written } = patchConfigDocument(doc, overlay);
  const same =
    JSON.stringify(next, null, 2) + "\n" ===
    JSON.stringify(doc, null, 2) + "\n";
  if (same) {
    writeLine(stdout, SETTINGS_PROMPTS.noChanges);
    return 0;
  }

  try {
    writeDocument(opts.dataDir, next);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      writeLine(stderr, SETTINGS_PROMPTS.eacces(configPath));
      return 1;
    }
    throw err;
  }

  writeLine(
    stdout,
    SETTINGS_PROMPTS.wrote(written as OverlayWrittenPath[], configPath),
  );
  return 0;
}
