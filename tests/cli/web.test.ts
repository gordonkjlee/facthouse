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
      dataDir: "C:\\Users\\alex\\.factmem",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overlay.sources).toEqual([
      { kind: "claude-code", home: "~/.claude", cwd: "C:\\dev\\app" },
    ]);
  });

  it("record leaves sources unset", () => {
    const parsed = parseInitWebPost(new URLSearchParams({ capture: "record" }), {
      processCwd: "C:\\dev\\app",
      dataDir: "C:\\Users\\alex\\.factmem",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overlay.sources).toBeUndefined();
  });
});

describe("parseSettingsWebPost", () => {
  it("maps More knobs without touching sources", () => {
    const overlay = parseSettingsWebPost(
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
    expect(overlay.cliModel).toBe("haiku");
    expect(overlay.cliIntegrateModel).toBe("sonnet");
    expect(overlay.cliTimeoutMs).toBe(60_000);
    expect(overlay.httpExtract).toBe(true);
    expect(overlay.httpModel).toBe("qwen2.5vl:7b");
    expect(overlay.httpExtractOnFail).toBe("none");
  });
});

describe("listenLoopback", () => {
  it("requires the token and Origin, then closes after a successful POST", async () => {
    const token = "test-token";
    const handle = await listenLoopback({
      token,
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
      dataDir: "C:\\Users\\alex\\.factmem",
      processCwd: "C:\\dev\\app",
    });
    expect(html).toMatch(/copy/);
    expect(html).toMatch(/record/);
  });
});
