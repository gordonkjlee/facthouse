import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CAPTURE_SOURCE_KINDS, DEFAULT_CONFIG } from "../../src/types/config.js";
import { defaultServerConfig } from "../../src/config.js";
import {
  INIT_KNOB_IDS,
  MORE_SETTING_IDS,
  INIT_PROMPTS,
  INIT_SYNTHETIC,
  applyInitOverlay,
  silentEmbeddingProvider,
  silentSources,
} from "../../src/cli/init-knobs.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

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
        "cwd",
        "cwdSkip",
        "dataDir",
        "embedding",
        "existingConfig",
        "forceHelp",
        "gitBashCwdHint",
        "home",
        "homeMissing",
        "intro",
        "kind",
        "mixPullLogEvent",
        "more",
        "moreCliModel",
        "moreCliTimeout",
        "moreCliTimeoutInvalid",
        "projectGroupMissing",
        "unknownKind",
      ].sort(),
    );
    expect(INIT_KNOB_IDS).toEqual(["dataDir", "sources", "embedding", "more"]);
    expect(MORE_SETTING_IDS).toEqual(["cliModel", "cliTimeoutMs"]);
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
    expect(cli).toMatch(/defaultDataDir/);
    expect(cli).toMatch(/resolveUserPath/);
    expect(cli).not.toMatch(/path\.join\(homedir\(/);
    expect(server).toMatch(/defaultDataDir/);
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
    expect(next.intelligence.provider).toBe("cli");
    const recommended = applyInitOverlay(defaultServerConfig(), {});
    expect(recommended.intelligence.cli?.model).toBeUndefined();
    expect(recommended.intelligence.cli?.timeout_ms).toBeUndefined();
  });

  it("applyInitOverlay ignores extra keys on a plain object", () => {
    const sneaky = {
      embeddingProvider: "voyage" as const,
      storage: { provider: "postgres" },
      intelligence: { provider: "heuristic" },
    };
    const next = applyInitOverlay(defaultServerConfig(), sneaky);
    expect(next.embedding.provider).toBe("voyage");
    expect(next.storage.provider).toBe("sqlite");
    expect(next.intelligence.provider).toBe(
      defaultServerConfig().intelligence.provider,
    );
  });

  it("README two-memories JSON uses INIT_SYNTHETIC paths", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf-8");
    const jsonEscape = (p: string) => p.replaceAll("\\", "\\\\");
    expect(readme).toContain(jsonEscape(INIT_SYNTHETIC.personalDir));
    expect(readme).toContain(jsonEscape(INIT_SYNTHETIC.workDir));
    expect(readme).toMatch(
      /non-default data directory prints a distinct MCP server name/i,
    );
  });

  it("scripted README init uses --yes, including inline npx", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf-8");
    const [beforeRef, afterRef = ""] = readme.split("### CLI Reference");
    const initCall = /\b(?:om|openmemory) init\b/g;
    for (const m of beforeRef.matchAll(/\b(?:om|openmemory) init\b([^`\n]*)/g)) {
      const rest = m[1] ?? "";
      expect(rest).toMatch(/(?:--yes|-y)\b/);
      expect(rest).not.toMatch(/^-y\b/);
    }
    const npxInit = /npx[^\n]*openmemory init([^\n`]*)/g;
    for (const m of beforeRef.matchAll(npxInit)) {
      expect(m[1]).toMatch(/--yes\b/);
    }
    const fenceRe = /```(?:bash|powershell)\n([\s\S]*?)```/g;
    for (const fence of afterRef.matchAll(fenceRe)) {
      const body = fence[1] ?? "";
      const live = [...body.matchAll(initCall)].filter((hit) => {
        const lineStart = body.lastIndexOf("\n", hit.index ?? 0);
        const line = body.slice(lineStart + 1).split("\n")[0] ?? "";
        return !line.trimStart().startsWith("#");
      });
      const withoutYes = live.filter((hit) => {
        const lineStart = body.lastIndexOf("\n", hit.index ?? 0);
        const line = body.slice(lineStart + 1).split("\n")[0] ?? "";
        return !/\b(?:--yes|-y)\b/.test(line);
      });
      expect(withoutYes.length).toBeLessThanOrEqual(1);
      if (withoutYes.length === 1) {
        const commands = body
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("#"));
        expect(commands).toHaveLength(1);
      }
    }
  });
});
