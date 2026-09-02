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
  INIT_PROMPTS,
  INIT_SYNTHETIC,
  SETTINGS_PROMPTS,
  SHIPPED_MORE_SHOWN,
  applyInitOverlay,
  moreShownFromConfig,
  silentEmbeddingProvider,
  silentSources,
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
    expect(quick).not.toMatch(/npm install -g/);
    expect(readme).toContain(INIT_PROMPTS.copyStorewide);
    expect(INIT_PROMPTS.shellNote).toMatch(/C:\/\.\.\./);
    expect(INIT_PROMPTS.shellNote).toMatch(/~\/ is expanded/);
    expect(readme).not.toMatch(/\$FACTMEM_DATA\b/);
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
    expect(INIT_PROMPTS.capture).toMatch(/Grok Build/);
    expect(INIT_PROMPTS.capture).toMatch(/\[copy\]: $/);
    expect(INIT_PROMPTS.kind).toMatch(/\[claude-code\]: $/);
    expect(INIT_PROMPTS.embedding).toMatch(/\[off\]: $/);
    expect(INIT_PROMPTS.more).toMatch(/\[N\]: $/);
    expect(INIT_PROMPTS.moreCliModel("haiku")).toBe(
      "Model to extract facts from messages  [haiku]: ",
    );
    expect(INIT_PROMPTS.moreCliIntegrateModel("haiku")).toBe(
      "Model to update long-term knowledge  [haiku]: ",
    );
    expect(INIT_PROMPTS.copyNow).toMatch(/\[Y\]: $/);
    expect(INIT_PROMPTS.extractNow).toMatch(/\[Y\]: $/);
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
        "copyNow",
        "copyStorewide",
        "copiedEvents",
        "cwd",
        "cwdSkip",
        "dataDir",
        "embedding",
        "extractNow",
        "extractSkippedHeuristic",
        "existingConfig",
        "forceHelp",
        "gitBashCwdHint",
        "home",
        "homeMissing",
        "intro",
        "kind",
        "mcpVsCli",
        "mixCopyLogEvent",
        "shellNote",
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
    expect(INIT_KNOB_IDS).toEqual(["dataDir", "sources", "embedding", "more"]);
    expect(MORE_SETTING_IDS).toEqual([
      "cliModel",
      "cliIntegrateModel",
      "cliTimeoutMs",
      "httpExtract",
      "httpBaseUrl",
      "httpModel",
      "httpExtractOnFail",
    ]);
    expect(INIT_PROMPTS.intro).toMatch(/Another store is another directory/);
    expect(INIT_PROMPTS.intro).not.toMatch(/two brains/i);
    expect(INIT_PROMPTS.intro).not.toMatch(/work and personal/i);
    expect(INIT_PROMPTS.homeMissing("~/.claude")).toContain("~/.claude");
    expect(INIT_PROMPTS.projectGroupMissing("~/.claude", "C:\\dev\\app", "C--dev-app")).toContain(
      "C--dev-app",
    );
  });

  it("CLI and MCP entry use defaultDataDir / resolveUserPath, not path.join(homedir()", () => {
    const cli = readFileSync(path.join(ROOT, "src/cli/index.ts"), "utf-8");
    const server = readFileSync(path.join(ROOT, "src/index.ts"), "utf-8");
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
    expect(next.intelligence.cli?.integrate_model).toBeUndefined();
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
    expect(recommended.intelligence.cli?.model).toBeUndefined();
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
    expect(readme).toContain(INIT_PROMPTS.mixCopyLogEvent);
  });

  it("scripted README init uses --yes, except a lone walk-through fence", () => {
    const readme = readmeText();
    const initCall = /\b(?:om|factmem) init\b([^`\n]*)/g;
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
        /^(?:om|factmem) init\s*$/.test(commands[0] ?? "")
      ) {
        return true;
      }
      if (
        commands.length === 1 &&
        /^npx -y -p "?@factmem\/mcp@\d+\.\d+\.\d+"? -- factmem init\s*$/.test(
          commands[0] ?? "",
        )
      ) {
        return true;
      }
      return (
        commands.length === 2 &&
        /^npm install -g @factmem\/mcp@\d+\.\d+\.\d+$/.test(commands[0] ?? "") &&
        /^(?:om|factmem) init\s*$/.test(commands[1] ?? "")
      );
    };

    let recipeB = 0;
    for (const fence of fences) {
      if (walkThroughFence(fence.body)) recipeB += 1;
    }
    expect(recipeB).toBeGreaterThanOrEqual(1);

    const installFence = fences.find((f) =>
      liveLines(f.body).some((l) => /^npm install -g @factmem\/mcp@\d+\.\d+\.\d+$/.test(l)),
    );
    expect(installFence).toBeDefined();
    expect(liveLines(installFence?.body ?? "")).toEqual([
      expect.stringMatching(/^npm install -g @factmem\/mcp@\d+\.\d+\.\d+$/),
      "factmem init --yes",
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

    for (const m of readme.matchAll(/npx[^\n]*factmem init([^\n`]*)/g)) {
      expect(m[1]).toMatch(/--yes\b/);
    }
  });

  it("Quick Start does not shout pull, hooks, embeddings, or a second store", () => {
    const readme = readmeText();
    const start = readme.indexOf("## Quick Start");
    const next = readme.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    const quick = readme.slice(start, next === -1 ? undefined : next);
    expect(quick).not.toMatch(/log-event/);
    expect(quick).not.toMatch(/"hooks"/);
    expect(quick).not.toMatch(/embedding\.provider/);
    expect(quick).not.toMatch(/intelligence\.http/);
    expect(quick).not.toMatch(/11434/);
    expect(quick).not.toMatch(/ollama pull/);
    expect(quick).not.toMatch(/factmem settings/);
    expect(quick).not.toMatch(/factmem pull/);
    expect(quick).not.toMatch(/--web/);
    expect(quick).not.toMatch(/\bStop\b/);
    expect(quick).not.toMatch(/openmemory-personal/);
    expect(quick).not.toMatch(/factmem-personal/);
    for (const fence of quick.matchAll(/```(?:bash|powershell|text|json)\n([\s\S]*?)```/g)) {
      expect(fence[1]).not.toMatch(/\bpull\b/);
    }
  });

  it("does not recommend a Stop hook as the pull path", () => {
    const readme = readmeText();
    expect(readme).not.toMatch(/"Stop"\s*:/);
    expect(readme).not.toMatch(/Stop tails new lines/);
    expect(readme).not.toMatch(/Stop-hook pull/);
  });

  it("later-editor copy names factmem settings, not TTY init as the later path", () => {
    const readme = readmeText();
    expect(readme).toMatch(/#### `factmem settings`/);
    expect(readme).toMatch(/later, `factmem settings`/i);
    const start = readme.indexOf("## Quick Start");
    const next = readme.indexOf("\n## ", start + 1);
    const quick = readme.slice(start, next === -1 ? undefined : next);
    expect(quick).not.toMatch(/factmem settings/);
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
