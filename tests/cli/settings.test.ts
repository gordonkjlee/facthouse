import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ConfigDocumentError,
  defaultServerConfig,
  mergeConfig,
} from "../../src/config.js";
import {
  HTTP_DEFAULT_BASE_URL,
  MORE_SETTING_IDS,
  SETTINGS_PROMPTS,
  SHIPPED_MORE_SHOWN,
  moreShownFromConfig,
} from "../../src/cli/init-knobs.js";
import { askMoreSettings, silentInitIo, type InitIo } from "../../src/cli/init-wizard.js";
import { runSettings } from "../../src/cli/settings.js";
import { INIT_PROMPTS } from "../../src/cli/init-knobs.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MAX_Q = 20;

function fakeIo(answers: string[]): InitIo & { prompts: string[]; writes: string[] } {
  let i = 0;
  let n = 0;
  const prompts: string[] = [];
  const writes: string[] = [];
  return {
    isTTY: true,
    prompts,
    writes,
    async question(prompt: string) {
      n += 1;
      if (n > MAX_Q) throw new Error("too many questions");
      prompts.push(prompt);
      if (i >= answers.length) throw new Error(`unexpected question: ${prompt}`);
      return answers[i++];
    },
    write(text: string) {
      writes.push(text);
    },
  };
}

function collect(stream: { chunks: string[] }) {
  return {
    chunks: stream.chunks,
    write(chunk: string) {
      stream.chunks.push(chunk);
    },
  };
}

describe("SETTINGS_PROMPTS", () => {
  it("has exactly the owned keys", () => {
    expect(Object.keys(SETTINGS_PROMPTS).sort()).toEqual(
      [
        "eacces",
        "intro",
        "malformed",
        "missing",
        "needTty",
        "noChanges",
        "notObject",
        "wrote",
      ].sort(),
    );
  });
});

describe("askMoreSettings settings walk", () => {
  it("skips the More gate and shows [Y] when extract is already HTTP", async () => {
    const io = fakeIo(["", "", "", "", "", "", ""]);
    const overlay = {};
    const shown = {
      ...SHIPPED_MORE_SHOWN,
      httpExtract: true,
      httpBaseUrl: "http://localhost:1234/v1",
      httpModel: "qwen2.5vl:7b",
      httpExtractOnFail: "none" as const,
    };
    await askMoreSettings(io, overlay, { cwd: () => "", exists: () => false, platform: () => "win32" }, {
      gate: false,
      shown,
    });
    expect(io.prompts.some((p) => p === INIT_PROMPTS.more)).toBe(false);
    expect(io.prompts.some((p) => p.includes("[Y]"))).toBe(true);
    expect(overlay.httpExtract).toBe(true);
    expect(overlay.httpBaseUrl).toBeUndefined();
    expect(overlay.httpExtractOnFail).toBeUndefined();
    expect(overlay.cliModel).toBeUndefined();
  });

  it("first enable prompts [cli] for on_fail and omits the key on Enter", async () => {
    const io = fakeIo(["", "", "", "y", "", "", ""]);
    const overlay = {};
    await askMoreSettings(io, overlay, { cwd: () => "", exists: () => false, platform: () => "win32" }, {
      gate: false,
      shown: SHIPPED_MORE_SHOWN,
    });
    expect(overlay.httpExtract).toBe(true);
    expect(overlay.httpExtractOnFail).toBeUndefined();
    expect(io.prompts.some((p) => p.includes("[cli]"))).toBe(true);
  });

  it("probes overlay URL, else shown URL, not the shipped Ollama default", async () => {
    const probed: string[] = [];
    const io = fakeIo(["", "", "", "", "", "", ""]);
    const overlay = {};
    await askMoreSettings(
      io,
      overlay,
      {
        cwd: () => "",
        exists: () => false,
        platform: () => "win32",
        probeHttp: async (base) => {
          probed.push(base);
          return { ok: true, ids: ["qwen2.5vl:7b"] };
        },
      },
      {
        gate: false,
        shown: {
          ...SHIPPED_MORE_SHOWN,
          httpExtract: true,
          httpBaseUrl: "http://localhost:1234/v1",
          httpModel: "qwen2.5vl:7b",
          httpExtractOnFail: "cli",
        },
      },
    );
    expect(probed).toEqual(["http://localhost:1234/v1"]);
    expect(probed[0]).not.toBe(HTTP_DEFAULT_BASE_URL);
  });

  it("init empty still writes URL and on_fail cli", async () => {
    const io = fakeIo(["y", "", "", "", "y", "", "", ""]);
    const overlay = {};
    await askMoreSettings(io, overlay, { cwd: () => "", exists: () => false, platform: () => "win32" }, {
      gate: true,
      shown: SHIPPED_MORE_SHOWN,
    });
    expect(overlay.httpExtract).toBe(true);
    expect(overlay.httpBaseUrl).toBe(HTTP_DEFAULT_BASE_URL);
    expect(overlay.httpExtractOnFail).toBe("cli");
  });
});

describe("runSettings", () => {
  it("refuses missing config.json without mkdir", async () => {
    const stderr = { chunks: [] as string[] };
    const stdout = { chunks: [] as string[] };
    const code = await runSettings({
      dataDir: "/tmp/factmem-no-such-store",
      json: false,

      stdinIsTTY: true,
      stdout: collect(stdout),
      stderr: collect(stderr),
      readDocument: () => {
        throw new ConfigDocumentError("missing", "missing");
      },
    });
    expect(code).toBe(1);
    expect(stderr.chunks.join("")).toContain("Run factmem init first");
    expect(stdout.chunks.join("")).not.toMatch(/Wrote/);
  });

  it("refuses malformed and non-object with distinct copy", async () => {
    const stderr = { chunks: [] as string[] };
    const malformed = await runSettings({
      dataDir: "/tmp/x",
      json: true,

      stdinIsTTY: false,
      stderr: collect(stderr),
      stdout: collect({ chunks: [] }),
      readDocument: () => {
        throw new ConfigDocumentError("malformed", "bad");
      },
    });
    expect(malformed).toBe(1);
    expect(stderr.chunks.join("")).toBe(SETTINGS_PROMPTS.malformed + "\n");

    const stderr2 = { chunks: [] as string[] };
    const notObj = await runSettings({
      dataDir: "/tmp/x",
      json: true,

      stdinIsTTY: false,
      stderr: collect(stderr2),
      stdout: collect({ chunks: [] }),
      readDocument: () => {
        throw new ConfigDocumentError("not-object", "arr");
      },
    });
    expect(notObj).toBe(1);
    expect(stderr2.chunks.join("")).toBe(SETTINGS_PROMPTS.notObject + "\n");
  });

  it("--json dumps More view and never writes; default on_fail is none", async () => {
    let wrote = false;
    const stdout = { chunks: [] as string[] };
    const doc = defaultServerConfig() as unknown as Record<string, unknown>;
    const code = await runSettings({
      dataDir: "/tmp/alex-store",
      json: true,

      stdinIsTTY: true,
      stdout: collect(stdout),
      stderr: collect({ chunks: [] }),
      readDocument: () => doc,
      writeDocument: () => {
        wrote = true;
      },
      io: silentInitIo(),
    });
    expect(code).toBe(0);
    expect(wrote).toBe(false);
    const parsed = JSON.parse(stdout.chunks.join(""));
    expect(parsed.data_dir).toBe("/tmp/alex-store");
    expect(parsed.more.httpExtract).toBe(false);
    expect(parsed.more.httpExtractOnFail).toBe("none");
    expect(parsed.more.httpModel).toBeNull();
    expect(JSON.stringify(parsed)).not.toMatch(/api_key/);
    for (const id of MORE_SETTING_IDS) {
      expect(parsed.more).toHaveProperty(id);
    }
  });

  it("non-TTY dumps human lines and needTty, does not call question", async () => {
    const stdout = { chunks: [] as string[] };
    let questioned = false;
    const code = await runSettings({
      dataDir: "/tmp/alex-store",
      json: false,

      stdinIsTTY: false,
      stdout: collect(stdout),
      stderr: collect({ chunks: [] }),
      readDocument: () => defaultServerConfig() as unknown as Record<string, unknown>,
      writeDocument: () => {
        throw new Error("must not write");
      },
      io: {
        isTTY: false,
        question: async () => {
          questioned = true;
          return "";
        },
        write: () => {},
      },
    });
    expect(code).toBe(0);
    expect(questioned).toBe(false);
    const text = stdout.chunks.join("");
    expect(text).toContain(SETTINGS_PROMPTS.needTty);
    expect(text).toMatch(/Local extract: no/);
    expect(text).toMatch(/Extract on-fail: none/);
  });

  it("Enter-through on a default store writes nothing", async () => {
    let wrote = false;
    const stdout = { chunks: [] as string[] };
    const io = fakeIo(["", "", "", "n"]);
    const doc = defaultServerConfig() as unknown as Record<string, unknown>;
    const code = await runSettings({
      dataDir: "/tmp/alex-store",
      json: false,

      stdinIsTTY: true,
      io,
      stdout: collect(stdout),
      stderr: collect({ chunks: [] }),
      readDocument: () => structuredClone(doc),
      writeDocument: () => {
        wrote = true;
      },
    });
    expect(code).toBe(0);
    expect(wrote).toBe(false);
    expect(stdout.chunks.join("")).toContain(SETTINGS_PROMPTS.noChanges);
  });

  it("writes timeout and reports JSON paths", async () => {
    const stdout = { chunks: [] as string[] };
    const io = fakeIo(["", "", "60000", "n"]);
    const doc: Record<string, unknown> = { consolidation: { threshold: 99 } };
    let saved: Record<string, unknown> | undefined;
    const code = await runSettings({
      dataDir: "/tmp/alex-store",
      json: false,

      stdinIsTTY: true,
      io,
      stdout: collect(stdout),
      stderr: collect({ chunks: [] }),
      readDocument: () => structuredClone(doc),
      writeDocument: (_dir, next) => {
        saved = next;
      },
    });
    expect(code).toBe(0);
    expect(saved?.consolidation).toEqual({ threshold: 99 });
    expect(
      (saved?.intelligence as { cli: { timeout_ms: number } }).cli.timeout_ms,
    ).toBe(60_000);
    expect(stdout.chunks.join("")).toContain("intelligence.cli.timeout_ms");
    expect(stdout.chunks.join("")).toMatch(/Reload the MCP server/);
  });

  it("EACCES is exit 1 with the eacces prompt", async () => {
    const stderr = { chunks: [] as string[] };
    const io = fakeIo(["", "", "60000", "n"]);
    const err = new Error("denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    const code = await runSettings({
      dataDir: "/tmp/alex-store",
      json: false,

      stdinIsTTY: true,
      io,
      stdout: collect({ chunks: [] }),
      stderr: collect(stderr),
      readDocument: () => ({ consolidation: { threshold: 1 } }),
      writeDocument: () => {
        throw err;
      },
    });
    expect(code).toBe(1);
    expect(stderr.chunks.join("")).toContain("permission denied");
  });

  it("patches timeout on a postgres file without connecting", async () => {
    const stdout = { chunks: [] as string[] };
    const io = fakeIo(["", "", "60000", "n"]);
    let saved: Record<string, unknown> | undefined;
    const code = await runSettings({
      dataDir: "/tmp/alex-pg",
      json: false,

      stdinIsTTY: true,
      io,
      stdout: collect(stdout),
      stderr: collect({ chunks: [] }),
      readDocument: () => ({ storage: { provider: "postgres" } }),
      writeDocument: (_dir, next) => {
        saved = next;
      },
    });
    expect(code).toBe(0);
    expect(saved?.storage).toEqual({ provider: "postgres" });
    expect(
      (saved?.intelligence as { cli: { timeout_ms: number } }).cli.timeout_ms,
    ).toBe(60_000);
  });

  it("does not import openStore, mkdir, or loadShippedStoreConfig", () => {
    const body = readFileSync(
      path.join(ROOT, "src/cli/settings.ts"),
      "utf-8",
    );
    expect(body).not.toMatch(/\bopenStore\b/);
    expect(body).not.toMatch(/\bmkdirSync\b/);
    expect(body).not.toMatch(/\bloadShippedStoreConfig\b/);
  });

  it("--json omits api_key even when the file has one", async () => {
    const stdout = { chunks: [] as string[] };
    const doc = mergeConfig(defaultServerConfig(), {
      intelligence: { api_key: "sk-alex-not-real" },
    }) as unknown as Record<string, unknown>;
    await runSettings({
      dataDir: "/tmp/alex-store",
      json: true,

      stdinIsTTY: false,
      stdout: collect(stdout),
      stderr: collect({ chunks: [] }),
      readDocument: () => doc,
      writeDocument: () => {
        throw new Error("must not write");
      },
    });
    expect(stdout.chunks.join("")).not.toContain("sk-alex-not-real");
    expect(stdout.chunks.join("")).not.toContain("api_key");
  });
});

describe("moreShownFromConfig walks MORE_SETTING_IDS", () => {
  it("includes every More id", () => {
    const shown = moreShownFromConfig(defaultServerConfig(), {});
    for (const id of MORE_SETTING_IDS) {
      expect(shown).toHaveProperty(id);
    }
  });
});
