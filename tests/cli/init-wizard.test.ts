import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAX_INIT_QUESTIONS,
  collectInitAnswers,
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

describe("storeCwdAnswer", () => {
  it("stores Enter as process cwd, skip as skip, and POSIX as typed", () => {
    expect(storeCwdAnswer("", "C:\\dev\\app")).toBe("C:\\dev\\app");
    expect(storeCwdAnswer("-", "C:\\dev\\app")).toBe("skip");
    expect(storeCwdAnswer("skip", "C:\\dev\\app")).toBe("skip");
    expect(storeCwdAnswer("/c/dev/app", "C:\\dev\\app")).toBe("/c/dev/app");
    expect(storeCwdAnswer("C:\\dev\\app", "C:\\other")).toBe("C:\\dev\\app");
    expect(storeCwdAnswer("app", "C:\\dev")).toBe(path.resolve("C:\\dev", "app"));
    expect(storeCwdAnswer("~/proj", "C:\\dev")).toBe(expandTilde("~/proj"));
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

  it("recommended path omits sources, search, and extra knobs", async () => {
    const io = fakeIo(["n", "off", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources).toBeUndefined();
    expect(result.overlay.embeddingProvider).toBeUndefined();
    expect(result.overlay.cliModel).toBeUndefined();
    expect(result.overlay.cliTimeoutMs).toBeUndefined();
    expect(result.captureAskedAndEmpty).toBe(true);
    expect(io.writes).toContain(INIT_PROMPTS.intro);
  });

  it("Enter through capture, search, and More leaves the overlay empty", async () => {
    const io = fakeIo(["", "", ""]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay).toEqual({});
    expect(result.writeConfig).toBe(true);
    expect(result.captureAskedAndEmpty).toBe(true);
  });

  it("unlocked data dir confirm then recommended answers", async () => {
    const unlocked: InitWizardSeed = { ...seed, dataDirLocked: false };
    const io = fakeIo(["", "n", "off", "n"]);
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
    const io = fakeIo(["n", "off", "n"]);
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
    const io = fakeIo(["y", "", "", "", "ollama", "y", "sonnet", "180000"]);
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
    expect(result.overlay.cliTimeoutMs).toBe(180_000);
    expect(result.captureAskedAndEmpty).toBe(false);
  });

  it("omits extra knobs when More is Y but answers are empty", async () => {
    const io = fakeIo(["n", "off", "y", "", ""]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.cliModel).toBeUndefined();
    expect(result.overlay.cliTimeoutMs).toBeUndefined();
  });

  it("writes a source, warns on a missing home, then asks search and More", async () => {
    const io = fakeIo(["y", "", "", "", "off", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources).toEqual([
      { kind: "claude-code", home: "~/.claude", cwd: "C:\\dev\\app" },
    ]);
    expect(io.writes).toContain(INIT_PROMPTS.homeMissing("~/.claude"));
    expect(result.captureAskedAndEmpty).toBe(false);
  });

  it("does not warn when the default home exists", async () => {
    const homeAbs = resolveUserPath("~/.claude");
    const io = fakeIo(["y", "", "", "", "off", "n"]);
    await collectInitAnswers(io, seed, deps(new Set([homeAbs])));
    expect(io.writes.join("\n")).not.toMatch(/does not exist yet/);
  });

  it("skips the source on cwd skip and still asks search and More", async () => {
    const io = fakeIo(["y", "", "", "skip", "off", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources).toBeUndefined();
    expect(result.captureAskedAndEmpty).toBe(true);
    expect(io.writes).toContain(INIT_PROMPTS.cwdSkip);
    expect(io.prompts).toContain(INIT_PROMPTS.embedding);
    expect(io.prompts).toContain(INIT_PROMPTS.more);
  });

  it("re-prompts an unknown kind and does not write grok", async () => {
    const io = fakeIo(["y", "grok", "claude-code", "", "", "off", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(io.writes).toContain(INIT_PROMPTS.unknownKind());
    expect(result.overlay.sources?.[0]?.kind).toBe("claude-code");
  });

  it("hints a POSIX cwd on Windows", async () => {
    const io = fakeIo(["y", "", "", "/c/dev/app", "off", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.sources?.[0]?.cwd).toBe("/c/dev/app");
    expect(io.writes.join("\n")).toMatch(/POSIX-looking cwd/);
  });

  it("re-prompts capture on a junk yes/no and then accepts N", async () => {
    const io = fakeIo(["maybe", "n", "off", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(io.prompts.filter((p) => p === INIT_PROMPTS.capture)).toHaveLength(2);
    expect(result.overlay.sources).toBeUndefined();
  });

  it("re-prompts embedding when Y is not a provider", async () => {
    const io = fakeIo(["n", "y", "off", "n"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(io.prompts.filter((p) => p === INIT_PROMPTS.embedding)).toHaveLength(2);
    expect(result.overlay.embeddingProvider).toBeUndefined();
  });

  it("sets voyage without extra knobs", async () => {
    const io = fakeIo(["n", "voyage", "n"]);
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

  it("re-prompts an invalid timeout", async () => {
    const io = fakeIo(["n", "off", "y", "haiku", "nope", "45000"]);
    const result = await collectInitAnswers(io, seed, deps());
    expect(result.overlay.cliModel).toBe("haiku");
    expect(result.overlay.cliTimeoutMs).toBe(45_000);
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
    expect(MORE_SETTING_IDS).toEqual(["cliModel", "cliTimeoutMs"]);
  });
});
