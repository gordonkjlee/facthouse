/**
 * Loopback HTML writer for `facthouse init --web` and `facthouse settings --web`.
 *
 * Binds 127.0.0.1 only. Prints the URL. Does not open a browser.
 * `--yes` must refuse to call this.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import {
  HTTP_DEFAULT_BASE_URL,
  INIT_PROMPTS,
  promptLabel,
  MORE_SETTING_IDS,
  defaultHomeForKind,
  walksOnInitMore,
  type InitOverlay,
  type MoreOverlay,
  type MoreShown,
  type MoreSettingId,
} from "./init-knobs.js";
import { isCaptureSourceKind, isStageOnFail } from "../types/config.js";
import {
  copyOrRecord,
  storeCwdAnswer,
  type InitWizardResult,
  type InitWizardSeed,
} from "./init-wizard.js";
import path from "node:path";
import { CONFIG_FILENAME } from "../config.js";
import { acceptTypedPath, resolveUserPath } from "../paths.js";
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
  /** Document title for POST responses (GET html is already wrapped). */
  title: string;
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
    const html = result.body.includes("<!DOCTYPE html>")
      ? result.body
      : wrapPage(opts.title, result.body);
    res.end(html);
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

function wrapPage(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en-GB" data-theme="system">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<title>${escapeHtml(title)}</title>
<style>
${ledgerInspectCss()}
html { box-sizing: border-box; }
*, *::before, *::after { box-sizing: inherit; }
body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
main { max-width: 36rem; width: 100%; margin: 0 auto; padding: 1.5rem 1.15rem 3rem; }
h1 { font-size: 1.35rem; color: var(--gold); }
label, .hint { display: block; margin: 0.85rem 0 0.25rem; }
.hint { color: var(--muted); font-size: 0.9rem; white-space: pre-wrap; overflow-wrap: break-word; }
.warn { color: var(--warn); margin: 0.85rem 0 0.25rem; }
.choice { display: flex; align-items: center; gap: 0.4rem; margin: 0.45rem 0; }
input[type="text"], input:not([type]), input[type="number"], select {
  width: 100%; padding: 0.45rem 0.55rem; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 0.3rem;
}
input[type="radio"], input[type="checkbox"] { width: auto; margin: 0; }
fieldset { border: 1px solid var(--line); border-radius: 0.4rem; margin: 1rem 0; padding: 0.75rem 1rem 1rem; }
legend { color: var(--gold); padding: 0 0.35rem; }
button { margin-top: 1.25rem; background: var(--gold); color: var(--mark); border: 0; padding: 0.55rem 1rem; border-radius: 0.3rem; font-weight: 600; cursor: pointer; }
.copy-only[hidden], .http-only[hidden], .more-only[hidden] { display: none; }
</style>
</head>
<body>
<main>
${inner}
</main>
</body>
</html>`;
}

/**
 * One More-knob field for both pages. Labels come from INIT_PROMPTS so the
 * terminal and the page cannot drift; `shown` fills current values (settings).
 */
function moreFieldHtml(
  id: MoreSettingId,
  shown?: MoreShown,
  posted?: URLSearchParams,
): string {
  const val = (v: string | number | undefined) =>
    v === undefined ? "" : ` value="${escapeHtml(String(v))}"`;
  const pick = (name: string, fallback: string | number | undefined) =>
    posted?.has(name) ? (posted.get(name) ?? "") : fallback;
  const httpOn = posted
    ? posted.get("httpExtract") === "yes"
    : Boolean(shown?.httpExtract);
  switch (id) {
    case "cliModel":
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreCliModel("")))} <input name="cliModel"${val(pick("cliModel", shown?.cliModel))} autocomplete="off" placeholder="haiku"></label>`;
    case "cliIntegrateModel":
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreCliIntegrateModel("")))} <input name="cliIntegrateModel"${val(pick("cliIntegrateModel", shown?.cliIntegrateModel))} autocomplete="off" placeholder="haiku"></label>`;
    case "cliTimeoutMs":
      return `<label>${escapeHtml(promptLabel(INIT_PROMPTS.moreCliTimeout("")))} <input name="cliTimeoutMs"${val(pick("cliTimeoutMs", shown?.cliTimeoutMs))} inputmode="numeric" autocomplete="off"></label>`;
    case "httpExtract":
      return `<label class="choice"><input type="checkbox" name="httpExtract" value="yes"${httpOn ? " checked" : ""}> ${escapeHtml(promptLabel(INIT_PROMPTS.moreHttpExtract("N")))}</label>`;
    case "httpBaseUrl":
      return `<div class="http-only"${httpOn ? "" : " hidden"}><label>${escapeHtml(promptLabel(INIT_PROMPTS.moreHttpBaseUrl("")))} <input name="httpBaseUrl"${val(pick("httpBaseUrl", shown?.httpBaseUrl))} placeholder="${escapeHtml(HTTP_DEFAULT_BASE_URL)}" autocomplete="off"></label></div>`;
    case "httpModel":
      return `<div class="http-only"${httpOn ? "" : " hidden"}><label>${escapeHtml(promptLabel(INIT_PROMPTS.moreHttpModel("", [])))} <input name="httpModel"${val(pick("httpModel", shown?.httpModel))} autocomplete="off"></label></div>`;
    case "httpExtractOnFail": {
      const current =
        pick("httpExtractOnFail", shown?.httpExtractOnFail) ?? "cli";
      const sel = (v: string) => (current === v ? " selected" : "");
      return `<div class="http-only"${httpOn ? "" : " hidden"}><label>${escapeHtml(promptLabel(INIT_PROMPTS.moreHttpOnFail("")))}
          <select name="httpExtractOnFail">
            <option value="cli"${sel("cli")}>cli</option>
            <option value="none"${sel("none")}>none</option>
            <option value="http"${sel("http")}>http</option>
          </select>
        </label></div>`;
    }
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

export const INIT_WEB_TITLE = `${CLI_NAME} setup`;
export const SETTINGS_WEB_TITLE = `${CLI_NAME} settings`;

function fieldWarn(field: string | undefined, want: string, message: string): string {
  if (field !== want) return "";
  return `<p class="warn">${escapeHtml(message)}</p>`;
}

export function renderInitWebHtml(opts: {
  token: string;
  dataDir: string;
  processCwd: string;
  homeDefaults?: Record<string, string>;
  posted?: URLSearchParams;
  error?: string;
  field?: string;
}): string {
  const posted = opts.posted;
  const homeDefaults = opts.homeDefaults ?? {
    "claude-code": defaultHomeForKind("claude-code", {}),
    cursor: defaultHomeForKind("cursor", {}),
  };
  const capture = posted?.get("capture") === "record" ? "record" : "copy";
  const kind = posted?.get("kind") === "cursor" ? "cursor" : "claude-code";
  const dataDir = posted?.get("dataDir") ?? opts.dataDir;
  const home = posted?.get("home") ?? homeDefaults[kind] ?? "";
  const cwd = posted?.get("cwd") ?? opts.processCwd;
  const moreOn = posted?.get("more") === "yes";
  const embedding = (posted?.get("embedding") ?? "off").toLowerCase();
  const moreFields = MORE_SETTING_IDS.filter(walksOnInitMore)
    .map((id) => moreFieldHtml(id))
    .join("\n  ");
  const inner = `
<h1>Facthouse setup</h1>
<p class="hint">${escapeHtml(INIT_PROMPTS.intro)}</p>
${opts.error && !opts.field ? `<p class="warn">${escapeHtml(opts.error)}</p>` : ""}
<form method="post" action="?token=${encodeURIComponent(opts.token)}">
  ${fieldWarn(opts.field, "dataDir", opts.error ?? "")}
  <label>Data directory
    <input name="dataDir" value="${escapeHtml(dataDir)}" autocomplete="off">
  </label>
  <fieldset>
    <legend>How conversations get in</legend>
    <p class="hint">${escapeHtml(INIT_PROMPTS.capture)}</p>
    ${fieldWarn(opts.field, "capture", opts.error ?? "")}
    <label class="choice"><input type="radio" name="capture" value="copy"${capture === "copy" ? " checked" : ""}> copy — session logs on disk</label>
    <label class="choice"><input type="radio" name="capture" value="record"${capture === "record" ? " checked" : ""}> record — the assistant saves facts as you talk</label>
    <div class="copy-only"${capture === "copy" ? "" : " hidden"}>
      <label>Source kind
        <select name="kind">
          <option value="claude-code"${kind === "claude-code" ? " selected" : ""}>Claude Code</option>
          <option value="cursor"${kind === "cursor" ? " selected" : ""}>Cursor</option>
        </select>
      </label>
      ${fieldWarn(opts.field, "home", opts.error ?? "")}
      <label>${escapeHtml(promptLabel(INIT_PROMPTS.home("")))}
        <input name="home" value="${escapeHtml(home)}" autocomplete="off">
      </label>
      ${fieldWarn(opts.field, "cwd", opts.error ?? "")}
      <label>${escapeHtml(promptLabel(INIT_PROMPTS.cwd("")))}
        <input name="cwd" value="${escapeHtml(cwd)}" autocomplete="off">
      </label>
    </div>
  </fieldset>
  <label class="choice"><input type="checkbox" name="more" value="yes"${moreOn ? " checked" : ""}> ${escapeHtml(promptLabel(INIT_PROMPTS.more))}</label>
  <div class="more-only"${moreOn ? "" : " hidden"}>
    <label>Semantic search
      <select name="embedding">
        <option value="off"${embedding === "off" ? " selected" : ""}>off</option>
        <option value="ollama"${embedding === "ollama" ? " selected" : ""}>ollama</option>
        <option value="voyage"${embedding === "voyage" ? " selected" : ""}>voyage</option>
      </select>
    </label>
    ${moreFields}
  </div>
  <button type="submit">Write config.json</button>
</form>
<script>
(function () {
  var form = document.querySelector("form");
  if (!form) return;
  var homes = ${JSON.stringify(homeDefaults)};
  function sync() {
    var copy = form.querySelector('input[name="capture"][value="copy"]');
    var block = form.querySelector(".copy-only");
    if (block) block.hidden = !(copy && copy.checked);
    var more = form.querySelector('input[name="more"]');
    var moreBlock = form.querySelector(".more-only");
    if (moreBlock) moreBlock.hidden = !(more && more.checked);
    var http = form.querySelector('input[name="httpExtract"]');
    form.querySelectorAll(".http-only").forEach(function (el) {
      el.hidden = !(http && http.checked);
    });
  }
  var kind = form.querySelector('select[name="kind"]');
  var home = form.querySelector('input[name="home"]');
  if (kind && home) {
    kind.addEventListener("change", function () {
      var next = homes[kind.value];
      if (typeof next === "string") home.value = next;
    });
  }
  form.addEventListener("change", sync);
  sync();
})();
</script>`;
  return wrapPage(INIT_WEB_TITLE, inner);
}

export type SettingsWebField = "cliTimeoutMs";

export function renderSettingsWebHtml(opts: {
  token: string;
  shown: MoreShown;
  posted?: URLSearchParams;
  error?: string;
  field?: SettingsWebField;
}): string {
  const s = opts.shown;
  const posted = opts.posted;
  const inner = `
<h1>Facthouse settings</h1>
<p class="hint">Extra knobs only. Capture and search stay as they are.</p>
${opts.error && !opts.field ? `<p class="warn">${escapeHtml(opts.error)}</p>` : ""}
<form method="post" action="?token=${encodeURIComponent(opts.token)}">
  ${MORE_SETTING_IDS.map((id) => {
    const warn = fieldWarn(opts.field, id, opts.error ?? "");
    return `${warn}${moreFieldHtml(id, s, posted)}`;
  }).join("\n  ")}
  <button type="submit">Save</button>
</form>
<script>
(function () {
  var form = document.querySelector("form");
  if (!form) return;
  function sync() {
    var http = form.querySelector('input[name="httpExtract"]');
    form.querySelectorAll(".http-only").forEach(function (el) {
      el.hidden = !(http && http.checked);
    });
  }
  form.addEventListener("change", sync);
  sync();
})();
</script>`;
  return wrapPage(SETTINGS_WEB_TITLE, inner);
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export type InitWebField = "dataDir" | "home" | "cwd" | "capture";

export function parseInitWebPost(
  params: URLSearchParams,
  opts: { processCwd: string; dataDir: string },
):
  | { ok: true; dataDir: string; overlay: InitOverlay }
  | { ok: false; error: string; field?: InitWebField } {
  const dataDirRaw = (params.get("dataDir") ?? "").trim();
  if (dataDirRaw !== "" && !acceptTypedPath(dataDirRaw, existsSync)) {
    return { ok: false, error: INIT_PROMPTS.notAPath, field: "dataDir" };
  }
  const dataDir = resolveUserPath(dataDirRaw === "" ? opts.dataDir : dataDirRaw);
  const choice = copyOrRecord(params.get("capture") ?? "copy");
  if (choice === "retry") {
    return { ok: false, error: "Type copy or record.", field: "capture" };
  }

  const overlay: InitOverlay = {};
  if (params.get("more") === "yes") {
    const embedding = (params.get("embedding") ?? "off").trim().toLowerCase();
    if (embedding === "ollama" || embedding === "voyage") {
      overlay.embeddingProvider = embedding;
    }
    applyMoreFromParams(params, overlay, { initEmpty: true, initWalk: true });
  }

  if (choice === "record") {
    return { ok: true, dataDir, overlay };
  }

  const kindRaw = (params.get("kind") ?? "claude-code").trim().toLowerCase();
  if (!isCaptureSourceKind(kindRaw)) {
    return { ok: false, error: INIT_PROMPTS.unknownKind() };
  }
  const homeRaw = (params.get("home") ?? "").trim();
  if (homeRaw !== "" && !acceptTypedPath(homeRaw, existsSync)) {
    return { ok: false, error: INIT_PROMPTS.notAPath, field: "home" };
  }
  const home = homeRaw || defaultHomeForKind(kindRaw, process.env);
  const cwdRaw = (params.get("cwd") ?? "").trim();
  if (
    cwdRaw !== "" &&
    cwdRaw !== "-" &&
    cwdRaw.toLowerCase() !== "skip" &&
    !acceptTypedPath(cwdRaw, existsSync)
  ) {
    return { ok: false, error: INIT_PROMPTS.notAPath, field: "cwd" };
  }
  const stored = storeCwdAnswer(cwdRaw, opts.processCwd);
  if (stored === "skip") {
    return { ok: false, error: INIT_PROMPTS.cwdSkip, field: "cwd" };
  }
  overlay.sources = [{ kind: kindRaw, home, cwd: stored }];
  return { ok: true, dataDir, overlay };
}

export function parseSettingsWebPost(
  params: URLSearchParams,
  shown?: MoreShown,
):
  | { ok: true; overlay: MoreOverlay }
  | { ok: false; error: string; field?: SettingsWebField } {
  const rawTimeout = (params.get("cliTimeoutMs") ?? "").trim();
  if (rawTimeout !== "" && !/^[0-9]+$/.test(rawTimeout)) {
    return {
      ok: false,
      error: INIT_PROMPTS.moreCliTimeoutInvalid,
      field: "cliTimeoutMs",
    };
  }
  if (rawTimeout !== "") {
    const n = Number.parseInt(rawTimeout, 10);
    if (!(n > 0)) {
      return {
        ok: false,
        error: INIT_PROMPTS.moreCliTimeoutInvalid,
        field: "cliTimeoutMs",
      };
    }
  }
  const overlay: MoreOverlay = {};
  applyMoreFromParams(params, overlay, { initEmpty: false, shown });
  return { ok: true, overlay };
}

/** Web create form only when there is no file (or --force). Verb, not unlocked. */
export function shouldServeInitWeb(
  seed: InitWizardSeed,
  configExists: boolean,
): boolean {
  if (seed.force) return true;
  return !configExists;
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
  if (!shouldServeInitWeb(seed, seedExists)) {
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
  const homeDefaults = {
    "claude-code": defaultHomeForKind("claude-code", process.env),
    cursor: defaultHomeForKind("cursor", process.env),
  };

  const handle = await listenLoopback({
    token,
    title: INIT_WEB_TITLE,
    html: renderInitWebHtml({
      token,
      dataDir: seed.dataDir,
      processCwd: opts.processCwd,
      homeDefaults,
    }),
    onPost: (params) => {
      const parsed = parseInitWebPost(params, {
        processCwd: opts.processCwd,
        dataDir: seed.dataDir,
      });
      if (!parsed.ok) {
        return {
          status: 400,
          body: renderInitWebHtml({
            token,
            dataDir: seed.dataDir,
            processCwd: opts.processCwd,
            homeDefaults,
            posted: params,
            error: parsed.error,
            field: parsed.field,
          }),
        };
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
    title: SETTINGS_WEB_TITLE,
    html: renderSettingsWebHtml({ token, shown: opts.shown }),
    onPost: (params) => {
      const parsed = parseSettingsWebPost(params, opts.shown);
      if (!parsed.ok) {
        return {
          status: 400,
          body: renderSettingsWebHtml({
            token,
            shown: opts.shown,
            posted: params,
            error: parsed.error,
            field: parsed.field,
          }),
        };
      }
      overlay = parsed.overlay;
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
  opts: { initEmpty: boolean; initWalk?: boolean; shown?: MoreShown },
): void {
  const shown = opts.shown;
  const postedHttp = params.get("httpExtract") === "yes";
  for (const id of MORE_SETTING_IDS) {
    if (opts.initWalk && !walksOnInitMore(id)) continue;
    switch (id) {
      case "cliModel": {
        const v = (params.get("cliModel") ?? "").trim();
        if (!v || (shown && v === shown.cliModel)) break;
        overlay.cliModel = v;
        break;
      }
      case "cliIntegrateModel": {
        const v = (params.get("cliIntegrateModel") ?? "").trim();
        if (!v || (shown && v === shown.cliIntegrateModel)) break;
        overlay.cliIntegrateModel = v;
        break;
      }
      case "cliTimeoutMs": {
        const raw = (params.get("cliTimeoutMs") ?? "").trim();
        if (raw && /^[0-9]+$/.test(raw)) {
          const n = Number.parseInt(raw, 10);
          if (n > 0 && !(shown && n === shown.cliTimeoutMs)) overlay.cliTimeoutMs = n;
        }
        break;
      }
      case "httpExtract": {
        if (shown && postedHttp === shown.httpExtract) break;
        overlay.httpExtract = postedHttp;
        break;
      }
      case "httpBaseUrl": {
        const httpOn = overlay.httpExtract ?? shown?.httpExtract ?? false;
        if (!httpOn) break;
        const v = (params.get("httpBaseUrl") ?? "").trim();
        if (shown && v === shown.httpBaseUrl) break;
        if (v) overlay.httpBaseUrl = v;
        else if (opts.initEmpty) overlay.httpBaseUrl = HTTP_DEFAULT_BASE_URL;
        break;
      }
      case "httpModel": {
        const httpOn = overlay.httpExtract ?? shown?.httpExtract ?? false;
        if (!httpOn) break;
        const v = (params.get("httpModel") ?? "").trim();
        if (shown && v === shown.httpModel) break;
        if (v) overlay.httpModel = v;
        break;
      }
      case "httpExtractOnFail": {
        const httpOn = overlay.httpExtract ?? shown?.httpExtract ?? false;
        if (!httpOn) break;
        const raw = (params.get("httpExtractOnFail") ?? "").trim().toLowerCase();
        if (shown && raw === shown.httpExtractOnFail) break;
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
