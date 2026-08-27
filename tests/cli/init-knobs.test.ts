import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CAPTURE_SOURCE_KINDS, DEFAULT_CONFIG } from "../../src/types/config.js";
import { defaultServerConfig } from "../../src/config.js";
import {
  INIT_KNOB_IDS,
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
        "cwd",
        "cwdSkip",
        "dataDir",
        "embedding",
        "existingConfig",
        "forceHelp",
        "home",
        "intro",
        "kind",
        "mixPullLogEvent",
        "unknownKind",
      ].sort(),
    );
    expect(INIT_KNOB_IDS).toEqual(["dataDir", "sources", "embedding"]);
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
});
