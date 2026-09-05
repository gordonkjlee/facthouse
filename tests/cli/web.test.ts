import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  listenLoopback,
  originAllowed,
  parseInitWebPost,
  parseSettingsWebPost,
  renderInitWebHtml,
  renderSettingsWebHtml,
  shouldServeInitWeb,
  INIT_WEB_TITLE,
  SETTINGS_WEB_TITLE,
} from "../../src/cli/web.js";
import { INIT_PROMPTS } from "../../src/cli/init-knobs.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("originAllowed", () => {
  it("accepts loopback origins for the bound port only", () => {
    expect(originAllowed("http://127.0.0.1:8765", 8765)).toBe(true);
    expect(originAllowed("http://localhost:8765", 8765)).toBe(true);
    expect(originAllowed("http://127.0.0.1:80", 8765)).toBe(false);
    expect(originAllowed("http://0.0.0.0:8765", 8765)).toBe(false);
    expect(originAllowed(undefined, 8765)).toBe(false);
  });
});

describe("parseInitWebPost", () => {
  it("copy requires cwd and writes one source", () => {
    const params = new URLSearchParams({
      capture: "copy",
      kind: "claude-code",
      home: "~/.claude",
      cwd: "C:\\dev\\app",
      embedding: "off",
    });
    const parsed = parseInitWebPost(params, {
      processCwd: "C:\\tmp",
      dataDir: "C:\\Users\\alex\\.facthouse",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overlay.sources).toEqual([
      { kind: "claude-code", home: "~/.claude", cwd: "C:\\dev\\app" },
    ]);
  });

  it("refuses a sentence as the data directory", () => {
    const parsed = parseInitWebPost(
      new URLSearchParams({
        dataDir: "please put it next to the repo",
        capture: "record",
      }),
      { processCwd: "C:\\dev\\app", dataDir: "C:\\Users\\alex\\.facthouse" },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(INIT_PROMPTS.notAPath);
  });

  it("record leaves sources unset", () => {
    const parsed = parseInitWebPost(new URLSearchParams({ capture: "record" }), {
      processCwd: "C:\\dev\\app",
      dataDir: "C:\\Users\\alex\\.facthouse",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overlay.sources).toBeUndefined();
  });
});

describe("parseSettingsWebPost", () => {
  it("maps More knobs without touching sources", () => {
    const parsed = parseSettingsWebPost(
      new URLSearchParams({
        cliModel: "haiku",
        cliIntegrateModel: "sonnet",
        cliTimeoutMs: "60000",
        httpExtract: "yes",
        httpBaseUrl: "http://localhost:1234/v1",
        httpModel: "qwen2.5vl:7b",
        httpExtractOnFail: "none",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overlay.cliModel).toBe("haiku");
    expect(parsed.overlay.cliIntegrateModel).toBe("sonnet");
    expect(parsed.overlay.cliTimeoutMs).toBe(60_000);
    expect(parsed.overlay.httpExtract).toBe(true);
    expect(parsed.overlay.httpModel).toBe("qwen2.5vl:7b");
    expect(parsed.overlay.httpExtractOnFail).toBe("none");
  });

  it("omits knobs that match the shown file", () => {
    const shown = {
      cliModel: "haiku",
      cliIntegrateModel: "sonnet",
      cliTimeoutMs: 45_000,
      httpExtract: false,
      httpBaseUrl: "http://localhost:11434/v1",
      httpModel: "",
      httpExtractOnFail: "cli" as const,
    };
    const parsed = parseSettingsWebPost(
      new URLSearchParams({
        cliModel: "haiku",
        cliIntegrateModel: "sonnet",
        cliTimeoutMs: "45000",
      }),
      shown,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overlay).toEqual({});
  });

  it("refuses a non-numeric timeout instead of saving", () => {
    const parsed = parseSettingsWebPost(new URLSearchParams({ cliTimeoutMs: "nope" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.field).toBe("cliTimeoutMs");
  });
});

describe("listenLoopback", () => {
  it("requires the token and Origin, then closes after a successful POST", async () => {
    const token = "test-token";
    const handle = await listenLoopback({
      token,
      title: INIT_WEB_TITLE,
      html: "<p>ok</p>",
      onPost: () => ({ status: 200, body: "<p>saved</p>", done: true }),
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${handle.port}/`);
      expect(missing.status).toBe(404);
      const get = await fetch(handle.url);
      expect(get.status).toBe(200);
      expect(await get.text()).toContain("ok");
      const badOrigin = await fetch(handle.url, {
        method: "POST",
        headers: { Origin: "http://example.com", "content-type": "application/x-www-form-urlencoded" },
        body: "capture=record",
      });
      expect(badOrigin.status).toBe(403);
      const ok = await fetch(handle.url, {
        method: "POST",
        headers: {
          Origin: `http://127.0.0.1:${handle.port}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "capture=record",
      });
      expect(ok.status).toBe(200);
      await handle.finished;
    } finally {
      await handle.close();
    }
  });
});

describe("web hang-safety", () => {
  it("does not open a browser and --yes copy refuses --web", () => {
    const body = readFileSync(path.join(ROOT, "src/cli/web.ts"), "utf-8");
    expect(body).not.toMatch(/xdg-open|open -a|start ""|webbrowser|openBrowser/);
    expect(INIT_PROMPTS.webYesRefuse).toMatch(/--yes/);
    expect(INIT_PROMPTS.webExisting).toMatch(/does not start a page/);
    expect(INIT_PROMPTS.webListening("http://127.0.0.1:9/?token=x")).toMatch(
      /does not open a browser/,
    );
    const html = renderInitWebHtml({
      token: "t",
      dataDir: "C:\\Users\\alex\\.facthouse",
      processCwd: "C:\\dev\\app",
    });
    expect(html).toMatch(/copy/);
    expect(html).toMatch(/record/);
    expect(html).toMatch(/box-sizing:\s*border-box/);
    expect(html).toContain(`<title>${INIT_WEB_TITLE}</title>`);
    expect(html).not.toMatch(/Idle silence/);
    expect(html).not.toMatch(/name="cliTimeoutMs"/);
    expect(html).not.toMatch(/name="httpExtractOnFail"/);
    expect(renderSettingsWebHtml({
      token: "t",
      shown: {
        cliModel: "haiku",
        cliIntegrateModel: "sonnet",
        cliTimeoutMs: 45_000,
        httpExtract: false,
        httpBaseUrl: "http://localhost:11434/v1",
        httpModel: "",
        httpExtractOnFail: "cli",
      },
    })).toContain(`<title>${SETTINGS_WEB_TITLE}</title>`);
  });
});

describe("shouldServeInitWeb", () => {
  it("does not serve create when a store already exists", () => {
    expect(
      shouldServeInitWeb(
        { dataDir: "C:\\Users\\alex\\.facthouse", dataDirLocked: false, force: false },
        true,
      ),
    ).toBe(false);
    expect(
      shouldServeInitWeb(
        { dataDir: "C:\\Users\\alex\\.facthouse", dataDirLocked: false, force: true },
        true,
      ),
    ).toBe(true);
    expect(
      shouldServeInitWeb(
        { dataDir: "C:\\Users\\alex\\.facthouse", dataDirLocked: false, force: false },
        false,
      ),
    ).toBe(true);
  });
});

describe("parseInitWebPost more", () => {
  it("ignores timeout and models unless more=yes", () => {
    const parsed = parseInitWebPost(
      new URLSearchParams({
        capture: "record",
        cliTimeoutMs: "999999",
        cliModel: "opus",
      }),
      { processCwd: "C:\\dev\\app", dataDir: "C:\\Users\\alex\\.facthouse" },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overlay.cliModel).toBeUndefined();
    expect(parsed.overlay.cliTimeoutMs).toBeUndefined();
  });

  it("still ignores timeout when More is checked", () => {
    const parsed = parseInitWebPost(
      new URLSearchParams({
        capture: "record",
        more: "yes",
        cliTimeoutMs: "999999",
        cliModel: "opus",
      }),
      { processCwd: "C:\\dev\\app", dataDir: "C:\\Users\\alex\\.facthouse" },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overlay.cliModel).toBe("opus");
    expect(parsed.overlay.cliTimeoutMs).toBeUndefined();
  });

  it("names the dataDir field when the path is prose", () => {
    const parsed = parseInitWebPost(
      new URLSearchParams({
        dataDir: "please put it next to the repo",
        capture: "record",
      }),
      { processCwd: "C:\\dev\\app", dataDir: "C:\\Users\\alex\\.facthouse" },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.field).toBe("dataDir");
  });
});

describe("400 re-shows the form wrap-once", () => {
  it("init POST 400 keeps one document and the --warn on the field", async () => {
    const token = "wrap-once";
    const seed = {
      token,
      dataDir: "C:\\Users\\alex\\.facthouse",
      processCwd: "C:\\dev\\app",
    };
    const handle = await listenLoopback({
      token,
      title: INIT_WEB_TITLE,
      html: renderInitWebHtml(seed),
      onPost: (params) => {
        const parsed = parseInitWebPost(params, {
          processCwd: seed.processCwd,
          dataDir: seed.dataDir,
        });
        if (!parsed.ok) {
          return {
            status: 400,
            body: renderInitWebHtml({
              ...seed,
              posted: params,
              error: parsed.error,
              field: parsed.field,
            }),
          };
        }
        return { status: 200, body: "<p>saved</p>", done: true };
      },
    });
    try {
      const res = await fetch(handle.url, {
        method: "POST",
        headers: {
          Origin: `http://127.0.0.1:${handle.port}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "dataDir=please+put+it+next+to+the+repo&capture=record",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html.match(/<!DOCTYPE html>/g)?.length).toBe(1);
      expect(html.match(/<html\b/g)?.length).toBe(1);
      expect(html).toContain('class="warn"');
      expect(html).toContain("<form");
      expect(html).toContain("please put it next to the repo");
      expect(html).toContain(`<title>${INIT_WEB_TITLE}</title>`);
    } finally {
      await handle.close();
    }
  });

  it("settings POST 400 keeps one document and does not fake a save", async () => {
    const token = "settings-400";
    const shown = {
      cliModel: "haiku",
      cliIntegrateModel: "sonnet",
      cliTimeoutMs: 45_000,
      httpExtract: false,
      httpBaseUrl: "http://localhost:11434/v1",
      httpModel: "",
      httpExtractOnFail: "cli" as const,
    };
    const handle = await listenLoopback({
      token,
      title: SETTINGS_WEB_TITLE,
      html: renderSettingsWebHtml({ token, shown }),
      onPost: (params) => {
        const parsed = parseSettingsWebPost(params, shown);
        if (!parsed.ok) {
          return {
            status: 400,
            body: renderSettingsWebHtml({
              token,
              shown,
              posted: params,
              error: parsed.error,
              field: parsed.field,
            }),
          };
        }
        return { status: 200, body: "<p>saved</p>", done: true };
      },
    });
    try {
      const res = await fetch(handle.url, {
        method: "POST",
        headers: {
          Origin: `http://127.0.0.1:${handle.port}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "cliTimeoutMs=nope",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html.match(/<!DOCTYPE html>/g)?.length).toBe(1);
      expect(html).toContain('class="warn"');
      expect(html).toContain("<form");
      expect(html).toContain(`<title>${SETTINGS_WEB_TITLE}</title>`);
      expect(html).toMatch(/name="cliTimeoutMs"[^>]*value="nope"/);
      expect(html.indexOf('class="warn"')).toBeLessThan(html.indexOf('name="cliTimeoutMs"'));
      expect(html.indexOf('name="cliTimeoutMs"')).toBeLessThan(html.indexOf('name="httpExtract"'));
    } finally {
      await handle.close();
    }
  });
});
