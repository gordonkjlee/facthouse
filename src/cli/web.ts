/**
 * Loopback HTML writer for `facthouse init --web` and `facthouse settings --web`.
 *
 * Binds 127.0.0.1 only. Prints the URL. Does not open a browser.
 * `--yes` must refuse to call this.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  HTTP_DEFAULT_BASE_URL,
  INIT_PROMPTS,
  MORE_SETTING_IDS,
  defaultHomeForKind,
  type InitOverlay,
  type MoreOverlay,
  type MoreShown,
  type MoreSettingId,
} from "./init-knobs.js";
import { isCaptureSourceKind, isStageOnFail } from "../types/config.js";
import {
  copyOrRecord,
  storeCwdAnswer,
  willAskQuestions,
  type InitWizardResult,
  type InitWizardSeed,
} from "./init-wizard.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILENAME } from "../config.js";
import { resolveUserPath } from "../paths.js";
import { ledgerInspectCss } from "./inspect-theme.js";
import { CLI_NAME } from "../identity.js";

export function newWizardToken(): string {
  return randomBytes(24).toString("base64url");
}

export function originAllowed(
  origin: string | undefined,
  port: number,
): boolean {
  if (!origin) return false;
  return (
    origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
  );
}

function tokenOf(url: URL, req: IncomingMessage): string | null {
  const q = url.searchParams.get("token");
  if (q) return q;
  const header = req.headers["x-facthouse-token"];
  if (typeof header === "string" && header.length > 0) return header;
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface LoopbackHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
  finished: Promise<void>;
}

export async function listenLoopback(opts: {
  token: string;
  html: string;
  onPost: (params: URLSearchParams) => {
    status: number;
    body: string;
    done?: boolean;
  };
}): Promise<LoopbackHandle> {
  let resolveFinished: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  let port = 0;

  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const token = tokenOf(url, req);
    if (token !== opts.token) {
      res.writeHead(token ? 403 : 404, { "content-type": "text/plain; charset=utf-8" });
      res.end(token ? "Forbidden" : "Not found");
      return;
    }

    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(opts.html);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    const origin = Array.isArray(req.headers.origin)
      ? req.headers.origin[0]
      : req.headers.origin;
    if (!originAllowed(origin, port)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden origin");
      return;
    }

    let params: URLSearchParams;
    try {
      const raw = await readBody(req);
      params = new URLSearchParams(raw);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Malformed body");
      return;
    }

    const result = opts.onPost(params);
    res.writeHead(result.status, { "content-type": "text/html; charset=utf-8" });
    res.end(wrapPage(result.body));
    if (result.done) {
      void close().then(() => resolveFinished());
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("loopback listen did not bind a port"));
        return;
      }
      port = addr.port;
      resolve();
    });
  });

  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }).catch(() => undefined);
  }

  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(opts.token)}`;
  return { url, port, close, finished };
}

function wrapPage(inner: string): string {
  return `<!DOCTYPE html>
<html lang="en-GB" data-theme="system">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${CLI_NAME} setup</title>
<style>
${ledgerInspectCss()}
body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
main { max-width: 36rem; margin: 0 auto; padding: 1.5rem 1.15rem 3rem; }
h1 { font-size: 1.35rem; color: var(--gold); }
label, .hint { display: block; margin: 0.85rem 0 0.25rem; }
.hint { color: var(--muted); font-size: 0.9rem; white-space: pre-wrap; }
input, select { width: 100%; padding: 0.45rem 0.55rem; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 0.3rem; }
fieldset { border: 1px solid var(--line); border-radius: 0.4rem; margin: 1rem 0; padding: 0.75rem 1rem 1rem; }
legend { color: var(--gold); padding: 0 0.35rem; }
button { margin-top: 1.25rem; background: var(--gold); color: var(--mark); border: 0; padding: 0.55rem 1rem; border-radius: 0.3rem; font-weight: 600; cursor: pointer; }
.copy-only[hidden] { display: none; }
</style>
</head>
<body>
<main>
${inner}
</main>
</body>
</html>`;
}

/** The prompt's first line, before the default in brackets: one label, one source. */
function promptLabel(prompt: string): string {
  const first = prompt.split("\n")[0] ?? prompt;
  return first.split("  [")[0]!.replace(/\?$/, "").trim();
}

/**
 * One More-knob field for both pages. Labels come from INIT_PROMPTS so the
 * terminal and the page cannot drift; `shown` fills current values (settings).
 */
function moreFieldHtml(id: MoreSettingId, shown?: MoreShown): string {
  const val = (v: string | number | undefined) =>
    v === undefined ? "" : ` value="${escapeHtml(String(v))}"`;
  switch (id) {
    case "cliModel":
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreCliModel("")))} <input name="cliModel"${val(shown?.cliModel)} autocomplete="off" placeholder="haiku"></label>`;
    case "cliIntegrateModel":
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreCliIntegrateModel("")))} <input name="cliIntegrateModel"${val(shown?.cliIntegrateModel)} autocomplete="off" placeholder="haiku"></label>`;
    case "cliTimeoutMs":
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreCliTimeout("")))} <input name="cliTimeoutMs"${val(shown?.cliTimeoutMs)} inputmode="numeric" autocomplete="off"></label>`;
    case "httpExtract":
      return `<label><input type="checkbox" name="httpExtract" value="yes"${shown?.httpExtract ? " checked" : ""}> ${escapeHtml(promptLabel(INIT_PROMPTS.moreHttpExtract("N")))}</label>`;
    case "httpBaseUrl":
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreHttpBaseUrl("")))} <input name="httpBaseUrl"${val(shown?.httpBaseUrl)} placeholder="${escapeHtml(HTTP_DEFAULT_BASE_URL)}" autocomplete="off"></label>`;
    case "httpModel":
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreHttpModel("", [])))} <input name="httpModel"${val(shown?.httpModel)} autocomplete="off"></label>`;
    case "httpExtractOnFail": {
      const sel = (v: string) => (shown ? (shown.httpExtractOnFail === v ? " selected" : "") : v === "cli" ? " selected" : "");
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreHttpOnFail("")))}
          <select name="httpExtractOnFail">
            <option value="cli"${sel("cli")}>cli</option>
            <option value="none"${sel("none")}>none</option>
            <option value="http"${sel("http")}>http</option>
          </select>
        </label>`;
    }
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

export function renderInitWebHtml(opts: {
  token: string;
  dataDir: string;
  processCwd: string;
}): string {
  const moreFields = MORE_SETTING_IDS.map((id) => moreFieldHtml(id)).join("\n  ");
  const inner = `
<h1>Facthouse setup</h1>
<p class="hint">${escapeHtml(INIT_PROMPTS.intro)}</p>
<form method="post" action="?token=${encodeURIComponent(opts.token)}">
  <label>Data directory
    <input name="dataDir" value="${escapeHtml(opts.dataDir)}" autocomplete="off">
  </label>
  <fieldset>
    <legend>How conversations get in</legend>
    <p class="hint">${escapeHtml(INIT_PROMPTS.capture)}</p>
    <label><input type="radio" name="capture" value="copy" checked> copy</label>
    <label><input type="radio" name="capture" value="record"> record</label>
    <div class="copy-only">
      <label>Source kind
        <select name="kind">
          <option value="claude-code" selected>claude-code</option>
          <option value="cursor">cursor</option>
        </select>
      </label>
      <label>Client config dir (home)
        <input name="home" placeholder="~/.claude" autocomplete="off">
      </label>
      <label>${escapeHtml(promptLabel(INIT_PROMPTS.cwd("")))}
        <input name="cwd" value="${escapeHtml(opts.processCwd)}" autocomplete="off">
      </label>
    </div>
  </fieldset>
  <label>Semantic search
    <select name="embedding">
      <option value="off" selected>off</option>
      <option value="ollama">ollama</option>
      <option value="voyage">voyage</option>
    </select>
  </label>
  <fieldset>
    <legend>More settings (optional)</legend>
    ${moreFields}
  </fieldset>
  <button type="submit">Write config.json</button>
</form>
<script>
(function () {
  var form = document.querySelector("form");
  if (!form) return;
  function sync() {
    var copy = form.querySelector('input[name="capture"][value="copy"]');
    var block = form.querySelector(".copy-only");
    if (block) block.hidden = !(copy && copy.checked);
  }
  form.addEventListener("change", sync);
  sync();
})();
</script>`;
  return wrapPage(inner);
}

export function renderSettingsWebHtml(opts: {
  token: string;
  shown: MoreShown;
}): string {
  const s = opts.shown;
  const inner = `
<h1>Facthouse settings</h1>
<p class="hint">Extra knobs only. Capture and search stay as they are.</p>
<form method="post" action="?token=${encodeURIComponent(opts.token)}">
  ${MORE_SETTING_IDS.map((id) => moreFieldHtml(id, s)).join("\n  ")}
  <button type="submit">Save</button>
</form>`;
  return wrapPage(inner);
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function parseInitWebPost(
  params: URLSearchParams,
  opts: { processCwd: string; dataDir: string },
): { ok: true; dataDir: string; overlay: InitOverlay } | { ok: false; error: string } {
  const dataDirRaw = (params.get("dataDir") ?? "").trim();
  const dataDir = resolveUserPath(dataDirRaw === "" ? opts.dataDir : dataDirRaw);
  const choice = copyOrRecord(params.get("capture") ?? "copy");
  if (choice === "retry") return { ok: false, error: "Type copy or record." };

  const overlay: InitOverlay = {};
  const embedding = (params.get("embedding") ?? "off").trim().toLowerCase();
  if (embedding === "ollama" || embedding === "voyage") {
    overlay.embeddingProvider = embedding;
  }

  applyMoreFromParams(params, overlay, { initEmpty: true });

  if (choice === "record") {
    return { ok: true, dataDir, overlay };
  }

  const kindRaw = (params.get("kind") ?? "claude-code").trim().toLowerCase();
  if (!isCaptureSourceKind(kindRaw)) {
    return { ok: false, error: INIT_PROMPTS.unknownKind() };
  }
  const home = (params.get("home") ?? "").trim() || defaultHomeForKind(kindRaw);
  const stored = storeCwdAnswer(params.get("cwd") ?? "", opts.processCwd);
  if (stored === "skip") {
    return { ok: false, error: INIT_PROMPTS.cwdSkip };
  }
  overlay.sources = [{ kind: kindRaw, home, cwd: stored }];
  return { ok: true, dataDir, overlay };
}

export function parseSettingsWebPost(params: URLSearchParams): MoreOverlay {
  const overlay: MoreOverlay = {};
  applyMoreFromParams(params, overlay, { initEmpty: false });
  return overlay;
}

export async function collectInitWebAnswers(
  seed: InitWizardSeed,
  opts: {
    stdout: { write(chunk: string): void };
    processCwd: string;
    exists?: (p: string) => boolean;
  },
): Promise<InitWizardResult> {
  const exists = opts.exists ?? existsSync;
  const seedExists = exists(path.join(seed.dataDir, CONFIG_FILENAME));
  if (!willAskQuestions(seed, seedExists)) {
    opts.stdout.write(INIT_PROMPTS.webExisting + "\n");
    return {
      dataDir: seed.dataDir,
      overlay: {},
      writeConfig: false,
      captureAskedAndEmpty: false,
      captureSkippedCwd: false,
    };
  }

  const token = newWizardToken();
  let dataDir = seed.dataDir;
  let overlay: InitOverlay = {};
  let captureAskedAndEmpty = false;

  const handle = await listenLoopback({
    token,
    html: renderInitWebHtml({
      token,
      dataDir: seed.dataDir,
      processCwd: opts.processCwd,
    }),
    onPost: (params) => {
      const parsed = parseInitWebPost(params, {
        processCwd: opts.processCwd,
        dataDir: seed.dataDir,
      });
      if (!parsed.ok) {
        return { status: 400, body: `<p>${escapeHtml(parsed.error)}</p>` };
      }
      dataDir = parsed.dataDir;
      overlay = parsed.overlay;
      captureAskedAndEmpty = overlay.sources === undefined;
      return {
        status: 200,
        body: `<p>${escapeHtml(INIT_PROMPTS.webSaved)}</p>`,
        done: true,
      };
    },
  });

  opts.stdout.write(INIT_PROMPTS.webListening(handle.url) + "\n");
  await handle.finished;
  return { dataDir, overlay, writeConfig: true, captureAskedAndEmpty, captureSkippedCwd: false };
}

export async function collectSettingsWebAnswers(opts: {
  shown: MoreShown;
  stdout: { write(chunk: string): void };
}): Promise<MoreOverlay> {
  const token = newWizardToken();
  let overlay: MoreOverlay = {};
  const handle = await listenLoopback({
    token,
    html: renderSettingsWebHtml({ token, shown: opts.shown }),
    onPost: (params) => {
      overlay = parseSettingsWebPost(params);
      return {
        status: 200,
        body: `<p>${escapeHtml(INIT_PROMPTS.webSaved)}</p>`,
        done: true,
      };
    },
  });
  opts.stdout.write(INIT_PROMPTS.webListening(handle.url) + "\n");
  await handle.finished;
  return overlay;
}

function applyMoreFromParams(
  params: URLSearchParams,
  overlay: MoreOverlay,
  opts: { initEmpty: boolean },
): void {
  for (const id of MORE_SETTING_IDS) {
    switch (id) {
      case "cliModel": {
        const v = (params.get("cliModel") ?? "").trim();
        if (v) overlay.cliModel = v;
        break;
      }
      case "cliIntegrateModel": {
        const v = (params.get("cliIntegrateModel") ?? "").trim();
        if (v) overlay.cliIntegrateModel = v;
        break;
      }
      case "cliTimeoutMs": {
        const raw = (params.get("cliTimeoutMs") ?? "").trim();
        if (raw && /^[0-9]+$/.test(raw)) {
          const n = Number.parseInt(raw, 10);
          if (n > 0) overlay.cliTimeoutMs = n;
        }
        break;
      }
      case "httpExtract": {
        overlay.httpExtract = params.get("httpExtract") === "yes";
        break;
      }
      case "httpBaseUrl": {
        if (!overlay.httpExtract) break;
        const v = (params.get("httpBaseUrl") ?? "").trim();
        if (v) overlay.httpBaseUrl = v;
        else if (opts.initEmpty) overlay.httpBaseUrl = HTTP_DEFAULT_BASE_URL;
        break;
      }
      case "httpModel": {
        if (!overlay.httpExtract) break;
        const v = (params.get("httpModel") ?? "").trim();
        if (v) overlay.httpModel = v;
        break;
      }
      case "httpExtractOnFail": {
        if (!overlay.httpExtract) break;
        const raw = (params.get("httpExtractOnFail") ?? "").trim().toLowerCase();
        if (isStageOnFail(raw)) overlay.httpExtractOnFail = raw;
        else if (opts.initEmpty) overlay.httpExtractOnFail = "cli";
        break;
      }
      default: {
        const _exhaustive: never = id;
        void _exhaustive;
      }
    }
  }
}
