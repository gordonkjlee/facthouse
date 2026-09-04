import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAX_INIT_QUESTIONS,
  collectInitAnswers,
  copyOrRecord,
  isInteractiveInit,
  silentInitIo,
  storeCwdAnswer,
  shouldHintGitBashCwd,
  type InitIo,
  type InitWizardDeps,
  type InitWizardSeed,
} from "../../src/cli/init-wizard.js";
import { INIT_PROMPTS, MORE_SETTING_IDS } from "../../src/cli/init-knobs.js";
import { CONFIG_FILENAME } from "../../src/config.js";
import { expandTilde, resolveUserPath } from "../../src/paths.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

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
      if (n > MAX_INIT_QUESTIONS) {
        throw new Error("too many questions");
      }
      prompts.push(prompt);
      if (i >= answers.length) {
        throw new Error(`unexpected question: ${prompt}`);
      }
      return answers[i++];
    },
    write(text: string) {
      writes.push(text);
    },
  };
}

const seed: InitWizardSeed = {
  dataDir: "/tmp/openmemory-try",
  dataDirLocked: true,
  force: false,
};

function deps(exists: Set<string> = new Set()): InitWizardDeps {
  return {
    cwd: () => "C:\\dev\\app",
    exists: (p) => exists.has(p),
    platform: () => "win32",
  };
}

describe("isInteractiveInit", () => {
  it("is false when stdin is not a TTY, even without --yes", () => {
    expect(
      isInteractiveInit({
        stdinIsTTY: false,
        yes: false,
        seed,
        configExists: false,
      }),
    ).toBe(false);
  });

  it("is false on a TTY when --yes is set", () => {
    expect(
      isInteractiveInit({
        stdinIsTTY: true,
        yes: true,
        seed,
        configExists: false,
      }),
    ).toBe(false);
  });

  it("is true on a TTY without --yes when writing", () => {
    expect(
      isInteractiveInit({
        stdinIsTTY: true,
        yes: false,
        seed,
        configExists: false,
      }),
    ).toBe(true);
  });

  it("is false on a TTY when the seed is locked and config exists", () => {
    expect(
      isInteractiveInit({
        stdinIsTTY: true,
        yes: false,
        seed,
        configExists: true,
      }),
    ).toBe(false);
  });

  it("is true on a TTY with --force even when config exists", () => {
    expect(
      isInteractiveInit({
        stdinIsTTY: true,
        yes: false,
        seed: { ...seed, force: true },
        configExists: true,
      }),
    ).toBe(true);
  });
});

describe("copyOrRecord", () => {
  it("treats Enter and copy as copy, record as record, junk as retry", () => {
    expect(copyOrRecord("")).toBe("copy");
    expect(copyOrRecord("copy")).toBe("copy");
    expect(copyOrRecord("C")).toBe("copy");
    expect(copyOrRecord("record")).toBe("record");
    expect(copyOrRecord("r")).toBe("record");
    expect(copyOrRecord("n")).toBe("retry");
    expect(copyOrRecord("y")).toBe("retry");
    expect(copyOrRecord("maybe")).toBe("retry");
  });
});

describe("storeCwdAnswer", () => {
  it("stores Enter as process cwd, skip as skip, and POSIX as typed", () => {
    expect(storeCwdAnswer("", "C:\\dev\\app")).toBe("C:\\dev\\app");
    expect(storeCwdAnswer("-", "C:\\dev\\app")).toBe("skip");
    expect(storeCwdAnswer("skip", "C:\\dev\\app")).toBe("skip");
    expect(storeCwdAnswer("/c/dev/app", "C:\\dev\\app")).toBe("/c/dev/app");
    expect(storeCwdAnswer("C:\\dev\\app", "C:\\other")).toBe("C:\\dev\\app");
    expect(storeCwdAnswer("app", "C:\\dev")).toBe(path.resolve("C:\\dev", "app"));
    expect(storeCwdAnswer("~/proj", "C:\\dev")).toBe(expandTilde("~/proj"));
    expect(storeCwdAnswer("~\\proj", "C:\\dev")).toBe(expandTilde("~\\proj"));
  });
});

describe("shouldHintGitBashCwd", () => {
  it("hints any leading-slash cwd on Windows only", () => {
    expect(shouldHintGitBashCwd("/c/dev/app", "win32")).toBe(true);
    expect(shouldHintGitBashCwd("/tmp/x", "win32")).toBe(true);
    expect(shouldHintGitBashCwd("/home/me/app", "linux")).toBe(false);
    expect(shouldHintGitBashCwd("C:\\dev\\app", "win32")).toBe(false);
  });
});

describe("collectInitAnswers", () => {
  it("does not call question on the silent path", async () => {
    const result = await collectInitAnswers(silentInitIo(), seed, deps());
    expect(result.writeConfig).toBe(true);
    expect(result.overlay).toEqual({});
    expect(result.captureAskedAndEmpty).toBe(false);
  });

  it("record path omits sources, search, and extra knobs", async () => {
    const io = fakeIo(["record", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources).toBeUndefined();
    expect(result.overlay.embeddingProvider).toBeUndefined();
    expect(result.overlay.cliModel).toBeUndefined();
    expect(result.overlay.cliTimeoutMs).toBeUndefined();
    expect(result.captureAskedAndEmpty).toBe(true);
    expect(io.writes).toContain(INIT_PROMPTS.intro);
  });

  it("Enter through copy writes a source with cwd, then search and More defaults", async () => {
    const io = fakeIo(["", "", "", "", ""]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources).toEqual([
      {
        kind: "claude-code",
        home: "~/.claude",
        cwd: "C:\\dev\\app",
      },
    ]);
    expect(result.overlay.embeddingProvider).toBeUndefined();
    expect(result.writeConfig).toBe(true);
    expect(result.captureAskedAndEmpty).toBe(false);
  });

  it("unlocked data dir confirm then record answers", async () => {
    const unlocked: InitWizardSeed = { ...seed, dataDirLocked: false };
    const io = fakeIo(["", "record", "n"]);
    const result = await collectInitAnswers(io, unlocked, deps());
    expect(result.dataDir).toBe(unlocked.dataDir);
    expect(result.overlay).toEqual({});
    expect(result.writeConfig).toBe(true);
  });

  it("unlocked path with an existing chosen config asks only the directory", async () => {
    const typed = "/tmp/chosen-store";
    const resolved = resolveUserPath(typed);
    const exists = new Set([path.join(resolved, CONFIG_FILENAME)]);
    const io = fakeIo([typed]);
    const result = await collectInitAnswers(
      io,
      { ...seed, dataDirLocked: false, dataDir: "/tmp/seed-store" },
      deps(exists),
    );
    expect(result.dataDir).toBe(resolved);
    expect(result.writeConfig).toBe(false);
    expect(result.overlay).toEqual({});
    expect(io.prompts).toHaveLength(1);
    expect(io.writes.join("\n")).not.toContain(INIT_PROMPTS.existingConfig);
  });

  it("--force on an existing config skips data dir and still asks the knobs", async () => {
    const exists = new Set([path.join(seed.dataDir, CONFIG_FILENAME)]);
    const io = fakeIo(["record", "n"]);
    const result = await collectInitAnswers(
      io,
      { ...seed, force: true },
      deps(exists),
    );
    expect(result.writeConfig).toBe(true);
    expect(result.overlay).toEqual({});
    expect(result.captureAskedAndEmpty).toBe(true);
    expect(io.prompts[0]).toBe(INIT_PROMPTS.capture);
  });

  it("writes one source with cwd and ollama, then extra knobs", async () => {
    const io = fakeIo(["copy", "", "", "", "y", "ollama", "sonnet", "", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources).toEqual([
      {
        kind: "claude-code",
        home: "~/.claude",
        cwd: "C:\\dev\\app",
      },
    ]);
    expect(result.overlay.embeddingProvider).toBe("ollama");
    expect(result.overlay.cliModel).toBe("sonnet");
    expect(result.overlay.cliIntegrateModel).toBeUndefined();
    expect(result.overlay.cliTimeoutMs).toBeUndefined();
    expect(result.captureAskedAndEmpty).toBe(false);
  });

  it("More local extract writes URL, model, and on_fail", async () => {
    const io = fakeIo([
      "record",
      "y",
      "",
      "",
      "",
      "y",
      "http://localhost:1234/v1",
      "qwen2.5vl:7b",
    ]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.httpExtract).toBe(true);
    expect(result.overlay.httpBaseUrl).toBe("http://localhost:1234/v1");
    expect(result.overlay.httpModel).toBe("qwen2.5vl:7b");
    expect(result.overlay.httpExtractOnFail).toBeUndefined();
  });

  it("More can set a heavier integrate model", async () => {
    const io = fakeIo(["record", "y", "", "", "sonnet", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.cliModel).toBeUndefined();
    expect(result.overlay.cliIntegrateModel).toBe("sonnet");
  });

  it("omits extra knobs when More is Y but answers are empty", async () => {
    const io = fakeIo(["record", "y", "", "", "", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.cliModel).toBeUndefined();
    expect(result.overlay.cliTimeoutMs).toBeUndefined();
  });

  it("writes a source, warns on a missing home, then asks search and More", async () => {
    const io = fakeIo(["copy", "", "", "", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources).toEqual([
      { kind: "claude-code", home: "~/.claude", cwd: "C:\\dev\\app" },
    ]);
    expect(io.writes).toContain(INIT_PROMPTS.homeMissing("~/.claude"));
    expect(result.captureAskedAndEmpty).toBe(false);
  });

  it("does not warn when the default home exists", async () => {
    const homeAbs = resolveUserPath("~/.claude");
    const io = fakeIo(["copy", "", "", "", "n"]);
    await collectInitAnswers(io, seed, deps(new Set([homeAbs])));
    expect(io.writes.join("\n")).not.toMatch(/does not exist yet/);
  });

  it("skips the source on cwd skip and still asks search and More", async () => {
    const io = fakeIo(["copy", "", "", "skip", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources).toBeUndefined();
    expect(result.captureAskedAndEmpty).toBe(true);
    expect(io.writes).toContain(INIT_PROMPTS.cwdSkip);
    expect(io.prompts).not.toContain(INIT_PROMPTS.embedding);
    expect(io.prompts).toContain(INIT_PROMPTS.more);
  });

  it("re-prompts an unknown kind and does not write grok", async () => {
    const io = fakeIo(["copy", "grok", "claude-code", "", "", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(io.writes).toContain(INIT_PROMPTS.unknownKind());
    expect(result.overlay.sources?.[0]?.kind).toBe("claude-code");
  });

  it("hints a POSIX cwd on Windows", async () => {
    const io = fakeIo(["copy", "", "", "/c/dev/app", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources?.[0]?.cwd).toBe("/c/dev/app");
    expect(io.writes.join("\n")).toMatch(/POSIX-looking cwd/);
  });

  it("re-prompts capture on junk and then accepts record", async () => {
    const io = fakeIo(["maybe", "record", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(io.prompts.filter((p) => p === INIT_PROMPTS.capture)).toHaveLength(2);
    expect(result.overlay.sources).toBeUndefined();
  });

  it("re-prompts embedding when Y is not a provider", async () => {
    const io = fakeIo(["record", "y", "y", "off", "", "", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(io.prompts.filter((p) => p === INIT_PROMPTS.embedding)).toHaveLength(2);
    expect(result.overlay.embeddingProvider).toBeUndefined();
  });

  it("sets voyage without extra knobs", async () => {
    const io = fakeIo(["record", "y", "voyage", "", "", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.embeddingProvider).toBe("voyage");
    expect(result.overlay.cliModel).toBeUndefined();
  });

  it("hits the question cap instead of hanging on junk answers", async () => {
    const io = fakeIo(Array(MAX_INIT_QUESTIONS + 1).fill("maybe"));
    await expect(collectInitAnswers(io, seed, deps())).rejects.toThrow(
      /too many questions/,
    );
  });

  it("init More does not ask timeout", async () => {
    const io = fakeIo(["record", "y", "", "haiku", "", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.cliModel).toBe("haiku");
    expect(result.overlay.cliTimeoutMs).toBeUndefined();
    expect(io.prompts.join("\n")).not.toMatch(/timeout/i);
  });

  it("preserve path asks nothing when locked and config exists", async () => {
    const exists = new Set([path.join(seed.dataDir, CONFIG_FILENAME)]);
    const io = fakeIo([]);
    const result = await collectInitAnswers(io, seed, deps(exists));
    expect(result.writeConfig).toBe(false);
    expect(result.overlay).toEqual({});
  });
});

describe("init-wizard file-scan", () => {
  it("does not name forbidden config fields", () => {
    const body = readFileSync(
      path.join(ROOT, "src/cli/init-wizard.ts"),
      "utf-8",
    );
    for (const word of [
      "intelligence",
      "temporal",
      "inferences",
      "domains",
      "extraction",
      "consolidation",
      "retention",
      "storage",
    ]) {
      expect(body).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
    expect(body).toContain("MORE_SETTING_IDS");
    expect(MORE_SETTING_IDS).toEqual([
      "cliModel",
      "cliIntegrateModel",
      "cliTimeoutMs",
      "httpExtract",
      "httpBaseUrl",
      "httpModel",
      "httpExtractOnFail",
    ]);
  });
});
