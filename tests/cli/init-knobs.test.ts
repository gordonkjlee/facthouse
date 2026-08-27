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
      ann: true,
    };
    const next = applyInitOverlay(defaultServerConfig(), sneaky);
    expect(next.embedding.provider).toBe("voyage");
    expect(next.storage.provider).toBe("sqlite");
    expect(next.embedding.ann).toBeNull();
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
    expect(readme).toContain(INIT_PROMPTS.mixPullLogEvent);
  });

  it("scripted README init uses --yes, except a lone walk-through fence", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf-8");
    const initCall = /\b(?:om|openmemory) init\b([^`\n]*)/g;
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

    const loneInitFence = (body: string) => {
      const commands = liveLines(body);
      return (
        commands.length === 1 && /^(?:om|openmemory) init\s*$/.test(commands[0] ?? "")
      );
    };

    let recipeB = 0;
    for (const fence of fences) {
      if (loneInitFence(fence.body)) recipeB += 1;
    }
    expect(recipeB).toBeGreaterThanOrEqual(1);

    const firstBash = readme.match(/```bash\n([\s\S]*?)```/);
    expect(firstBash).not.toBeNull();
    expect(liveLines(firstBash?.[1] ?? "")).toEqual(["openmemory init"]);

    for (const m of readme.matchAll(initCall)) {
      const at = m.index ?? 0;
      const lineStart = readme.lastIndexOf("\n", at) + 1;
      const line = readme.slice(lineStart, readme.indexOf("\n", at));
      if (/^#{1,6}\s/.test(line.trim())) continue;
      const fence = fences.find((f) => at >= f.start && at < f.end);
      if (fence && loneInitFence(fence.body)) continue;
      const rest = m[1] ?? "";
      expect(rest).toMatch(/(?:--yes|-y)\b/);
      expect(rest).not.toMatch(/^-y\b/);
    }

    for (const m of readme.matchAll(/npx[^\n]*openmemory init([^\n`]*)/g)) {
      expect(m[1]).toMatch(/--yes\b/);
    }
  });

  it("Quick Start does not shout pull, hooks, embeddings, or a second store", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf-8");
    const start = readme.indexOf("## Quick Start");
    const next = readme.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    const quick = readme.slice(start, next === -1 ? undefined : next);
    expect(quick).not.toMatch(/log-event/);
    expect(quick).not.toMatch(/"hooks"/);
    expect(quick).not.toMatch(/embedding\.provider/);
    expect(quick).not.toMatch(/openmemory-personal/);
    for (const fence of quick.matchAll(/```bash\n([\s\S]*?)```/g)) {
      expect(fence[1]).not.toMatch(/\bpull\b/);
    }
  });

  it("How it works is two speeds without paper names", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf-8");
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
