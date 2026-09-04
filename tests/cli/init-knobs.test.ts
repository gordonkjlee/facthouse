import { EXTRACT_CAP_EVENTS } from "../../src/intelligence/steps.js";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CAPTURE_SOURCE_KINDS,
  DEFAULT_CONFIG,
  HTTP_WELL_KNOWN_BASE_URLS,
} from "../../src/types/config.js";
import { defaultServerConfig } from "../../src/config.js";
import {
  INIT_KNOB_IDS,
  MORE_SETTING_IDS,
  CLI_DEFAULT_TIMEOUT_MS,
  CLI_HISTORIC_TIMEOUT_MS,
  INIT_PROMPTS,
  INIT_SYNTHETIC,
  SETTINGS_PROMPTS,
  SHIPPED_MORE_SHOWN,
  applyInitOverlay,
  moreShownFromConfig,
  silentEmbeddingProvider,
  silentSources,
  applyMoreOverlayToIntelligence,
  defaultHomeForKind,
} from "../../src/cli/init-knobs.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Checkout on Windows may be CRLF; fence scans are written against LF. */
function readmeText(): string {
  return readFileSync(path.join(ROOT, "README.md"), "utf-8").replace(/\r\n/g, "\n");
}

describe("init knobs — one definition", () => {
  it("silent sources copy DEFAULT_CONFIG and do not share the array", () => {
    const copy = silentSources();
    expect(copy).toEqual([]);
    expect(copy).toEqual(DEFAULT_CONFIG.sources);
    Object.freeze(DEFAULT_CONFIG.sources);
    copy.push({
      kind: "claude-code",
      home: INIT_SYNTHETIC.claudeHome,
      cwd: INIT_SYNTHETIC.cwd,
    });
    expect(DEFAULT_CONFIG.sources).toEqual([]);
    expect(silentSources()).toEqual([]);
  });

  it("silent embedding is DEFAULT_CONFIG.embedding.provider (null)", () => {
    expect(silentEmbeddingProvider()).toBe(DEFAULT_CONFIG.embedding.provider);
    expect(silentEmbeddingProvider()).toBeNull();
  });

  it("README repeats INIT_PROMPTS.mcpVsCli so global vs npx is one definition", () => {
    const readme = readmeText();
    expect(readme).toContain(INIT_PROMPTS.mcpVsCli);
    const start = readme.indexOf("## Quick Start");
    const next = readme.indexOf("\n## ", start + 1);
    const quick = readme.slice(start, next === -1 ? undefined : next);
    expect(quick).not.toContain(INIT_PROMPTS.mcpVsCli);
    expect(readme).toContain(INIT_PROMPTS.shellNote);
    expect(quick).not.toContain(INIT_PROMPTS.shellNote);
    expect(quick).toMatch(/npm install -g @facthouse\/mcp@\d+\.\d+\.\d+/);
    expect(readme).toContain(INIT_PROMPTS.copyStorewide);
    expect(INIT_PROMPTS.shellNote).toMatch(/C:\/\.\.\./);
    expect(INIT_PROMPTS.shellNote).toMatch(/~\/ is expanded/);
    expect(readme).not.toMatch(/\$FACTHOUSE_DATA\b/);
    expect(readme).toContain(INIT_PROMPTS.mcpPasteNoCli);
    expect(quick).not.toContain(INIT_PROMPTS.mcpPasteNoCli);
    expect(readme).toContain(INIT_PROMPTS.quickStartNext);
    expect(quick).toContain(INIT_PROMPTS.quickStartNext);
    expect(readme).toContain(INIT_PROMPTS.mcpEnvNotCli);
    expect(quick).not.toContain(INIT_PROMPTS.mcpEnvNotCli);
    expect(quick).toContain(INIT_PROMPTS.mcpInstallClash);
    expect(readme).toContain(INIT_PROMPTS.storeDir);
    expect(quick).not.toContain(INIT_PROMPTS.storeDir);
  });

  it("Unix-only path or env recipes have a following PowerShell fence", () => {
    const readme = readmeText();
    const fenceRe = /```(bash|powershell)\n([\s\S]*?)```/g;
    const fences: Array<{ lang: string; body: string }> = [];
    for (const m of readme.matchAll(fenceRe)) {
      fences.push({ lang: m[1] ?? "", body: m[2] ?? "" });
    }
    const live = (body: string) =>
      body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
    const needsPair = (line: string) =>
      line.startsWith("export ") ||
      /(?:^|\s)\/tmp\//.test(line) ||
      line.startsWith("rm -rf ");
    let paired = 0;
    for (let i = 0; i < fences.length; i++) {
      const fence = fences[i];
      if (fence.lang !== "bash") continue;
      if (!live(fence.body).some(needsPair)) continue;
      expect(fences[i + 1]?.lang).toBe("powershell");
      paired += 1;
    }
    expect(paired).toBeGreaterThan(0);
  });

  it("capture prompt is copy versus record", () => {
    expect(INIT_PROMPTS.capture).toMatch(/\[copy\]/);
    expect(INIT_PROMPTS.capture).toMatch(/\bcopy\b/);
    expect(INIT_PROMPTS.capture).toMatch(/\brecord\b/);
    expect(INIT_PROMPTS.capture).toMatch(/\bGrok\b/);
    expect(INIT_PROMPTS.capture).not.toMatch(/\bhere\b/);
    expect(INIT_PROMPTS.capture).toMatch(/\[copy\]: $/);
    expect(INIT_PROMPTS.kind).toMatch(/\[claude-code\]: $/);
    expect(INIT_PROMPTS.home("~/.claude")).toMatch(/not the project/);
    expect(INIT_PROMPTS.cwd("C:\\dev\\app")).toMatch(/project folder/);
    expect(INIT_PROMPTS.embedding).toMatch(/\[off\]: $/);
    expect(INIT_PROMPTS.more).toMatch(/\[N\]: $/);
    expect(INIT_PROMPTS.moreCliModel("haiku")).toBe("Extract model  [haiku]: ");
    expect(INIT_PROMPTS.moreCliIntegrateModel("haiku")).toBe(
      "Integrate model  [haiku]: ",
    );
    expect(INIT_PROMPTS.historicCopy).toMatch(/\[Y\]: $/);
    expect(INIT_PROMPTS.historicCopy).toMatch(/\n  N  /);
    expect(INIT_PROMPTS.historicExtract).toMatch(/\[all\]: $/);
    expect(INIT_PROMPTS.historicExtract).toMatch(/\n  N  /);
  });

  it("kind prompt names every shipped kind and not grok", () => {
    for (const kind of CAPTURE_SOURCE_KINDS) {
      expect(INIT_PROMPTS.kind).toContain(kind);
    }
    expect(INIT_PROMPTS.kind).not.toMatch(/grok/i);
    const unknown = INIT_PROMPTS.unknownKind();
    for (const kind of CAPTURE_SOURCE_KINDS) {
      expect(unknown).toContain(`"${kind}"`);
    }
  });

  it("INIT_PROMPTS has exactly the owned keys", () => {
    expect(Object.keys(INIT_PROMPTS).sort()).toEqual(
      [
        "capture",
        "captureDeclined",
        "historicCopy",
        "historicExtract",
        "copyStorewide",
        "configMalformed",
        "copiedLines",
        "copyingNow",
        "cwd",
        "cwdSkip",
        "cwdSkipped",
        "copyRecipe",
        "copyNext",
        "integrated",
        "dataDir",
        "embedding",

        "extractProgress",
        "extractSkippedHeuristic",
        "extractTimedOut",
        "extractingNow",
        "existingConfig",
        "forceHelp",
        "gitBashCwdHint",
        "home",
        "homeMissing",
        "intro",
        "kind",
        "mcpEnvNotCli",
        "mcpInstallClash",
        "mcpPasteNoCli",
        "mcpVsCli",
        "quickStartNext",
        "mixCopyRecord",
        "notAPath",
        "shellNote",
        "storeDir",
        "more",
        "webExisting",
        "webListening",
        "webSaved",
        "webYesRefuse",
        "moreCliModel",
        "moreCliIntegrateModel",
        "moreCliTimeout",
        "moreCliTimeoutInvalid",
        "moreHttpBaseUrl",
        "moreHttpExtract",
        "moreHttpModel",
        "moreHttpOnFail",
        "moreHttpOnFailInvalid",
        "projectGroupMissing",
        "unknownKind",
      ].sort(),
    );
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
    expect(SHIPPED_MORE_SHOWN.httpExtractOnFail).toBe("cli");
    expect(moreShownFromConfig(defaultServerConfig(), {}).httpExtractOnFail).toBe(
      "none",
    );
    expect(INIT_KNOB_IDS).toEqual(["dataDir", "sources", "more"]);
    expect(defaultHomeForKind("claude-code")).toBe("~/.claude");
    expect(
      defaultHomeForKind("claude-code", {
        CLAUDE_CONFIG_DIR: "C:/Users/alex/.claude-work",
      }),
    ).toBe("C:/Users/alex/.claude-work");
    expect(defaultHomeForKind("cursor")).toBe("~/.cursor");
    expect(MORE_SETTING_IDS).toEqual([
      "cliModel",
      "cliIntegrateModel",
      "cliTimeoutMs",
      "httpExtract",
      "httpBaseUrl",
      "httpModel",
      "httpExtractOnFail",
    ]);
    expect(INIT_PROMPTS.intro).toContain(INIT_PROMPTS.storeDir);
    expect(INIT_PROMPTS.storeDir).toMatch(/same path/i);
    expect(INIT_PROMPTS.storeDir).toMatch(/second directory/i);
    expect(INIT_PROMPTS.storeDir).not.toMatch(/\bmemory\b/i);
    expect(INIT_PROMPTS.intro).not.toMatch(/two brains/i);
    expect(INIT_PROMPTS.intro).not.toMatch(/work and personal/i);
    expect(CLI_HISTORIC_TIMEOUT_MS).toBeGreaterThan(CLI_DEFAULT_TIMEOUT_MS);
    expect(INIT_PROMPTS.extractTimedOut(180)).toMatch(/180s/);
    expect(INIT_PROMPTS.extractTimedOut(180)).not.toMatch(/[Cc]ontinuing/);
    expect(INIT_PROMPTS.moreCliTimeout("45000")).toMatch(/Idle silence/);
    expect(INIT_PROMPTS.extractingNow(3)).not.toMatch(/several minutes/);
    expect(INIT_PROMPTS.homeMissing("~/.claude")).toContain("~/.claude");
    expect(INIT_PROMPTS.projectGroupMissing("~/.claude", "C:\\dev\\app", "C--dev-app")).toContain(
      "C--dev-app",
    );
  });

  it("CLI and MCP entry use defaultDataDir / resolveUserPath, not path.join(homedir()", () => {
    const cli = readFileSync(path.join(ROOT, "src/cli/run.ts"), "utf-8");
    const server = readFileSync(path.join(ROOT, "src/server.ts"), "utf-8");
    expect(cli).toMatch(/timeoutMs:\s*CLI_HISTORIC_TIMEOUT_MS/);
    expect(cli).toMatch(/dataDirFromEnvOrDefault/);
    expect(cli).toMatch(/resolveUserPath/);
    expect(cli).not.toMatch(/path\.join\(homedir\(/);
    expect(server).toMatch(/dataDirFromEnvOrDefault/);
    expect(server).toMatch(/resolveUserPath/);
    expect(server).not.toMatch(/path\.join\(homedir\(/);
  });

  it("applyInitOverlay sets only embedding.provider", () => {
    const next = applyInitOverlay(defaultServerConfig(), {
      embeddingProvider: "ollama",
    });
    expect(next.embedding.provider).toBe("ollama");
    expect(next.embedding.api_key_env).toBe(
      defaultServerConfig().embedding.api_key_env,
    );
    expect(next.embedding.batch_size).toBe(
      defaultServerConfig().embedding.batch_size,
    );
    expect(next.storage.provider).toBe("sqlite");
    expect(next.intelligence.provider).toBe(
      defaultServerConfig().intelligence.provider,
    );
  });

  it("applyInitOverlay writes model and timeout only when set", () => {
    const next = applyInitOverlay(defaultServerConfig(), {
      cliModel: "sonnet",
      cliTimeoutMs: 180_000,
    });
    expect(next.intelligence.cli?.model).toBe("sonnet");
    expect(next.intelligence.cli?.timeout_ms).toBe(180_000);
    expect(next.intelligence.cli?.integrate_model).toBe("sonnet");
    expect(next.intelligence.provider).toBe("cli");
    const split = applyInitOverlay(defaultServerConfig(), {
      cliModel: "haiku",
      cliIntegrateModel: "sonnet",
    });
    expect(split.intelligence.cli?.model).toBe("haiku");
    expect(split.intelligence.cli?.integrate_model).toBe("sonnet");
    const same = applyInitOverlay(defaultServerConfig(), {
      cliModel: "sonnet",
      cliIntegrateModel: "sonnet",
    });
    expect(same.intelligence.cli?.model).toBe("sonnet");
    expect(same.intelligence.cli?.integrate_model).toBeUndefined();
    const withHttp = applyInitOverlay(defaultServerConfig(), {
      httpExtract: true,
      httpBaseUrl: "http://localhost:1234/v1",
      httpModel: "qwen2.5vl:7b",
      httpExtractOnFail: "none",
    });
    expect(withHttp.intelligence.http?.base_url).toBe("http://localhost:1234/v1");
    expect(withHttp.intelligence.http?.model).toBe("qwen2.5vl:7b");
    expect(withHttp.intelligence.stages?.extract).toEqual({
      provider: "http",
      on_fail: "none",
    });
    const recommended = applyInitOverlay(defaultServerConfig(), {});
    expect(recommended.intelligence.cli?.model).toBe("haiku");
    expect(recommended.intelligence.cli?.integrate_model).toBe("sonnet");
    expect(recommended.intelligence.cli?.timeout_ms).toBeUndefined();
  });

  it("applyInitOverlay ignores extra keys on a plain object", () => {
    const sneaky = {
      embeddingProvider: "voyage" as const,
      storage: { provider: "postgres" },
      intelligence: { provider: "heuristic" },
      ann: true,
      interlocutor: { role_weights: { user: 2 } },
      disk_budget: "2GB",
    };
    const next = applyInitOverlay(defaultServerConfig(), sneaky);
    expect(next.embedding.provider).toBe("voyage");
    expect(next.storage.provider).toBe("sqlite");
    expect(next.embedding.ann).toBeNull();
    expect(next.intelligence.provider).toBe(
      defaultServerConfig().intelligence.provider,
    );
    expect(next.interlocutor).toBeUndefined();
    expect(next.retention.disk_budget).toBeUndefined();
    expect(defaultServerConfig().interlocutor).toBeUndefined();
  });

  it("README two-memories JSON uses INIT_SYNTHETIC paths", () => {
    const readme = readmeText();
    const jsonEscape = (p: string) => p.replaceAll("\\", "\\\\");
    expect(readme).toContain(jsonEscape(INIT_SYNTHETIC.personalDir));
    expect(readme).toContain(jsonEscape(INIT_SYNTHETIC.workDir));
    expect(readme).toMatch(
      /non-default data directory prints a distinct MCP server name/i,
    );
    expect(readme).toContain(INIT_PROMPTS.mixCopyRecord);
  });

  it("scripted README init uses --yes, except a lone walk-through fence", () => {
    const readme = readmeText();
    const initCall = /\b(?:om|facthouse) init\b([^`\n]*)/g;
    const fenceRe = /```(?:bash|powershell)\n([\s\S]*?)```/g;
    const fences: Array<{ start: number; end: number; body: string }> = [];
    for (const fence of readme.matchAll(fenceRe)) {
      const body = fence[1] ?? "";
      const start = fence.index ?? 0;
      fences.push({ start, end: start + fence[0].length, body });
    }

    const liveLines = (body: string) =>
      body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));

    const walkThroughFence = (body: string) => {
      const commands = liveLines(body);
      if (
        commands.length === 1 &&
        /^(?:om|facthouse) init\s*$/.test(commands[0] ?? "")
      ) {
        return true;
      }
      if (
        commands.length === 1 &&
        /^npx -y -p "?@facthouse\/mcp@\d+\.\d+\.\d+"? -- facthouse init\s*$/.test(
          commands[0] ?? "",
        )
      ) {
        return true;
      }
      return (
        commands.length === 2 &&
        /^npm install -g @facthouse\/mcp@\d+\.\d+\.\d+$/.test(commands[0] ?? "") &&
        /^(?:om|facthouse) init\s*$/.test(commands[1] ?? "")
      );
    };

    let recipeB = 0;
    for (const fence of fences) {
      if (walkThroughFence(fence.body)) recipeB += 1;
    }
    expect(recipeB).toBeGreaterThanOrEqual(1);

    const silentInstall = fences.find((f) =>
      liveLines(f.body).some((l) =>
        /^npm install -g @facthouse\/mcp@\d+\.\d+\.\d+$/.test(l),
      ) && liveLines(f.body).some((l) => /init --yes\s*$/.test(l)),
    );
    expect(silentInstall).toBeDefined();
    expect(liveLines(silentInstall?.body ?? "")).toEqual([
      expect.stringMatching(/^npm install -g @facthouse\/mcp@\d+\.\d+\.\d+$/),
      "facthouse init --yes",
    ]);

    const wizardInstall = fences.find((f) => walkThroughFence(f.body) &&
      liveLines(f.body).some((l) =>
        /^npm install -g @facthouse\/mcp@\d+\.\d+\.\d+$/.test(l),
      ),
    );
    expect(wizardInstall).toBeDefined();
    expect(liveLines(wizardInstall?.body ?? "")).toEqual([
      expect.stringMatching(/^npm install -g @facthouse\/mcp@\d+\.\d+\.\d+$/),
      "facthouse init",
    ]);

    const quickStartAt = readme.indexOf("## Quick Start");
    const quickStartEnd = readme.indexOf("\n## ", quickStartAt + 1);

    for (const m of readme.matchAll(initCall)) {
      const at = m.index ?? 0;
      const lineStart = readme.lastIndexOf("\n", at) + 1;
      const line = readme.slice(lineStart, readme.indexOf("\n", at));
      if (/^#{1,6}\s/.test(line.trim())) continue;
      const fence = fences.find((f) => at >= f.start && at < f.end);
      if (fence && walkThroughFence(fence.body)) continue;
      const rest = m[1] ?? "";
      expect(rest).toMatch(/(?:--yes|-y)\b/);
      expect(rest).not.toMatch(/^-y\b/);
    }

    for (const m of readme.matchAll(/npx[^\n]*facthouse init([^\n`]*)/g)) {
      expect(m[1]).toMatch(/--yes\b/);
    }
  });

  it("Quick Start does not shout copy steps, hooks, embeddings, or a second store", () => {
    const readme = readmeText();
    const start = readme.indexOf("## Quick Start");
    const next = readme.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    const quick = readme.slice(start, next === -1 ? undefined : next);
    expect(quick).not.toMatch(/log-event/);
    expect(quick).not.toMatch(/facthouse record/);
    expect(quick).not.toMatch(/"hooks"/);
    expect(quick).not.toMatch(/embedding\.provider/);
    expect(quick).not.toMatch(/intelligence\.http/);
    expect(quick).not.toMatch(/11434/);
    expect(quick).not.toMatch(/ollama pull/);
    expect(quick).not.toMatch(/facthouse settings/);
    expect(quick).not.toMatch(/facthouse pull/);
    expect(quick).not.toMatch(/--web/);
    expect(quick).not.toMatch(/\bStop\b/);
    expect(quick).not.toMatch(/openmemory-personal/);
    expect(quick).not.toMatch(/facthouse-personal/);
    for (const fence of quick.matchAll(/```(?:bash|powershell|text|json)\n([\s\S]*?)```/g)) {
      expect(fence[1]).not.toMatch(/\bpull\b/);
    }
  });

  it("README states the extract cap with the one constant, in every sentence that names it", () => {
    const readme = readmeText();
    const cap = String(EXTRACT_CAP_EVENTS);
    // Each sentence that teaches the cap must carry the same number the
    // engine enforces; a change to EXTRACT_CAP_EVENTS must fail here.
    expect(readme).toContain(`extracts facts from the oldest ${cap} lines`);
    expect(readme).toContain(`Extract is capped at ${cap} lines per run`);
    expect(readme).toContain(`A first backfill of more than ${cap} lines`);
    expect(readme).toContain(INIT_PROMPTS.mixCopyRecord);
  });

  it("init's copy recipe and the extract prompt name the cap once", () => {
    expect(INIT_PROMPTS.historicExtract).not.toContain(String(EXTRACT_CAP_EVENTS));
    expect(INIT_PROMPTS.copyNext()).toContain(String(EXTRACT_CAP_EVENTS));
    expect(INIT_PROMPTS.copyNext()).toMatch(new RegExp(`^Run ${"facthouse"} consolidate`));
    expect(INIT_PROMPTS.copyNext("C:/dev/app/.facthouse")).toContain("--data");
    expect(INIT_PROMPTS.integrated(3, 7)).toMatch(/7 line\(s\) remain/);
    expect(INIT_PROMPTS.integrated(3, 0)).not.toMatch(/remain/);
  });

  it("does not recommend a Stop hook as the copy path", () => {
    const readme = readmeText();
    expect(readme).not.toMatch(/"Stop"\s*:/);
    expect(readme).not.toMatch(/Stop tails new lines/);
    expect(readme).not.toMatch(/Stop-hook pull/);
  });

  it("later-editor copy names facthouse settings, not TTY init as the later path", () => {
    const readme = readmeText();
    expect(readme).toMatch(/#### `facthouse settings`/);
    expect(readme).toMatch(/later, `facthouse settings`/i);
    const start = readme.indexOf("## Quick Start");
    const next = readme.indexOf("\n## ", start + 1);
    const quick = readme.slice(start, next === -1 ? undefined : next);
    expect(quick).not.toMatch(/facthouse settings/);
  });

  it("does not tell anyone to ollama pull", () => {
    expect(readmeText()).not.toMatch(/ollama pull/);
  });

  it("names well-known OpenAI-compat roots only after Quick Start", () => {
    const readme = readmeText();
    const start = readme.indexOf("## Quick Start");
    const next = readme.indexOf("\n## ", start + 1);
    const quick = readme.slice(start, next === -1 ? undefined : next);
    expect(HTTP_WELL_KNOWN_BASE_URLS.length).toBeGreaterThan(1);
    for (const row of HTTP_WELL_KNOWN_BASE_URLS) {
      expect(readme).toContain(row.base_url);
      expect(quick).not.toContain(row.base_url);
    }
  });

  it("How it works is two speeds without paper names", () => {
    const readme = readmeText();
    const start = readme.indexOf("## How it works");
    const next = readme.indexOf("\n## ", start + 1);
    const body = readme.slice(start, next === -1 ? undefined : next);
    expect(body).toMatch(/two speeds/i);
    expect(body).not.toMatch(/hippocampus/i);
    expect(body).not.toMatch(/McClelland/);
    expect(body).not.toMatch(/decisions\.md/);
    expect(body).not.toMatch(/ADR-/);
  });
});

describe("legacy intelligence.cli.graduate_model on a settings write", () => {
  it("migrates the key on an Enter-through walk, so the notice stops repeating", () => {
    const { intel, written } = applyMoreOverlayToIntelligence(
      { provider: "cli", cli: { model: "haiku", graduate_model: "sonnet" } },
      {},
      "patch",
    );
    const cli = intel?.cli as Record<string, unknown>;
    expect(cli.integrate_model).toBe("sonnet");
    expect(cli).not.toHaveProperty("graduate_model");
    expect(written).toContain("intelligence.cli.integrate_model");
  });

  it("keeps the new key when both are present", () => {
    const { intel } = applyMoreOverlayToIntelligence(
      { provider: "cli", cli: { graduate_model: "old", integrate_model: "new" } },
      {},
      "patch",
    );
    const cli = intel?.cli as Record<string, unknown>;
    expect(cli.integrate_model).toBe("new");
    expect(cli).not.toHaveProperty("graduate_model");
  });
});
