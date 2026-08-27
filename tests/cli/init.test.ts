import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";


const {
  initDataDir,
  mcpConfigSnippet,
  mcpServerName,
  mcpSnippetDataDir,
  providerStatusLines,
  sourcesStatusLines,
} = await import("../../src/cli/init.js");
const { CONFIG_FILENAME, loadConfig, defaultServerConfig } = await import("../../src/config.js");
const { defaultDataDir } = await import("../../src/paths.js");

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "om-init-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("initDataDir", () => {
  it("creates the data dir, database with schema, and default config", async () => {
    const dataDir = path.join(root, "fresh");
    const result = await initDataDir({ dataDir });

    expect(result.createdDataDir).toBe(true);
    expect(result.wroteConfig).toBe(true);
    expect(result.configPreserved).toBe(false);
    expect(existsSync(result.dbPath)).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
    // Schema actually applied, not just an empty file.
    expect(result.schemaVersion).toBeGreaterThan(0);
  });

  it("writes a config.json that round-trips to the shipped defaults", async () => {
    const dataDir = path.join(root, "cfg");
    await initDataDir({ dataDir });

    const written = JSON.parse(
      readFileSync(path.join(dataDir, CONFIG_FILENAME), "utf-8"),
    );
    expect(written).toEqual(defaultServerConfig());
    // Loading it back yields the same effective config as the defaults.
    expect(loadConfig(dataDir)).toEqual(defaultServerConfig());
  });

  it("surfaces the tunable knobs users otherwise can't discover", async () => {
    const dataDir = path.join(root, "knobs");
    await initDataDir({ dataDir });
    const written = JSON.parse(
      readFileSync(path.join(dataDir, CONFIG_FILENAME), "utf-8"),
    );
    expect(written.intelligence.provider).toBe("cli");
    // Deliberately absent. It used to be written as "heuristic" and read by
    // nothing — the terminal fallback is not configurable, because it is the
    // only provider that cannot itself fail. A knob that does nothing is worse
    // than no knob, so this asserts it stays gone.
    expect(written.intelligence).not.toHaveProperty("fallback");
    expect(written.consolidation.triggers).toBeInstanceOf(Array);
    expect(written.extraction).toHaveProperty("enabled");
    expect(written.retention).toHaveProperty("prune_keep_per_session");
    // Pull is off until the user names a source. The empty list must be
    // written so the knob is discoverable rather than invisible.
    expect(written.sources).toEqual([]);
    expect(written.storage.provider).toBe("sqlite");
  });

  it("refuses postgres before creating memory.db", async () => {
    const dataDir = path.join(root, "pg");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, CONFIG_FILENAME),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    await expect(initDataDir({ dataDir })).rejects.toThrow(/postgres/);
    await expect(initDataDir({ dataDir })).rejects.toThrow(/SQLite was not opened/);
    expect(existsSync(path.join(dataDir, "memory.db"))).toBe(false);
  });

  it("is idempotent — a second run preserves an edited config", async () => {
    const dataDir = path.join(root, "again");
    await initDataDir({ dataDir });

    // Simulate the user tuning their config.
    const configPath = path.join(dataDir, CONFIG_FILENAME);
    const edited = { ...defaultServerConfig(), consolidation: { triggers: ["manual"], threshold: 99, auto_link_events: 1 } };
    writeFileSync(configPath, JSON.stringify(edited, null, 2), "utf-8");

    const second = await initDataDir({ dataDir });
    expect(second.createdDataDir).toBe(false);
    expect(second.wroteConfig).toBe(false);
    expect(second.configPreserved).toBe(true);

    // The user's edit survived.
    const after = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(after.consolidation.threshold).toBe(99);
  });

  it("writes an overlay when creating config.json", async () => {
    const dataDir = path.join(root, "overlay");
    await initDataDir({
      dataDir,
      overlay: { embeddingProvider: "ollama" },
    });
    const written = JSON.parse(
      readFileSync(path.join(dataDir, CONFIG_FILENAME), "utf-8"),
    );
    expect(written.embedding.provider).toBe("ollama");
    expect(written.embedding.api_key_env).toBe(
      defaultServerConfig().embedding.api_key_env,
    );
    expect(written.storage.provider).toBe("sqlite");
  });

  it("ignores overlay when preserving an existing config", async () => {
    const dataDir = path.join(root, "preserve-overlay");
    await initDataDir({ dataDir });
    await initDataDir({
      dataDir,
      overlay: { embeddingProvider: "voyage" },
    });
    const written = JSON.parse(
      readFileSync(path.join(dataDir, CONFIG_FILENAME), "utf-8"),
    );
    expect(written.embedding.provider).toBeNull();
  });

  it("--force resets an existing config back to defaults", async () => {
    const dataDir = path.join(root, "forced");
    await initDataDir({ dataDir });
    const configPath = path.join(dataDir, CONFIG_FILENAME);
    writeFileSync(configPath, JSON.stringify({ intelligence: { provider: "heuristic" } }), "utf-8");

    const forced = await initDataDir({ dataDir, force: true });
    expect(forced.wroteConfig).toBe(true);
    expect(forced.configPreserved).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual(defaultServerConfig());
  });

  it("re-running preserves existing data (does not recreate the database)", async () => {
    const dataDir = path.join(root, "data");
    await initDataDir({ dataDir });

    const m: any = await import("../../src/db/index.js");
    const dbPath = path.join(dataDir, "memory.db");

    const db = m.openDatabase(dbPath);
    await m.createSession(db, { source_tool: "test", project: null });
    await m.closeDatabase(db);

    const second = await initDataDir({ dataDir });
    expect(second.createdDataDir).toBe(false);

    const db2 = m.openDatabase(dbPath);
    const count = (await db2.prepare("SELECT COUNT(*) AS n FROM sessions").get()) as { n: number };
    await m.closeDatabase(db2);
    expect(count.n).toBe(1);
  });

  it("creates nested data directories that don't exist yet", async () => {
    const dataDir = path.join(root, "deeply", "nested", "dir");
    const result = await initDataDir({ dataDir });
    expect(result.createdDataDir).toBe(true);
    expect(existsSync(result.dbPath)).toBe(true);
  });
});

describe("mcpConfigSnippet", () => {
  it("emits valid JSON with no env entry for the default location", () => {
    const parsed = JSON.parse(mcpConfigSnippet("@openmem/mcp@1.2.3"));
    const entry = parsed.mcpServers.openmemory;
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "@openmem/mcp@1.2.3"]);
    expect(entry.env).toBeUndefined();
  });

  it("escapes a Windows data dir so the snippet stays valid JSON", () => {
    // Raw interpolation of this path would emit unescaped backslashes and
    // produce a snippet that fails to parse when pasted into a client config.
    const winPath = "C:\\Users\\someone\\AppData\\Local\\openmemory";
    const snippet = mcpConfigSnippet("@openmem/mcp@1.2.3", winPath);

    const parsed = JSON.parse(snippet); // would throw on unescaped backslashes
    expect(parsed.mcpServers.openmemory.env.OPENMEMORY_DATA).toBe(winPath);
  });

  it("survives quotes in the path without breaking the JSON", () => {
    const nasty = '/tmp/we"ird/pa\\th';
    const parsed = JSON.parse(mcpConfigSnippet("@openmem/mcp", nasty));
    expect(parsed.mcpServers.openmemory.env.OPENMEMORY_DATA).toBe(nasty);
  });

  it("indents every line for console output", () => {
    const snippet = mcpConfigSnippet("@openmem/mcp", undefined, 4);
    for (const line of snippet.split("\n")) {
      expect(line.startsWith("    ")).toBe(true);
    }
  });

  it("uses a distinct server name so two brains can share one mcp.json", () => {
    const personal = JSON.parse(
      mcpConfigSnippet("@openmem/mcp", "/tmp/openmemory-personal", 0, "openmemory-personal"),
    );
    const work = JSON.parse(
      mcpConfigSnippet("@openmem/mcp", "/tmp/openmemory-work", 0, "openmemory-work"),
    );
    expect(Object.keys(personal.mcpServers)).toEqual(["openmemory-personal"]);
    expect(Object.keys(work.mcpServers)).toEqual(["openmemory-work"]);
    expect(personal.mcpServers["openmemory-personal"].env.OPENMEMORY_DATA).toBe(
      "/tmp/openmemory-personal",
    );
    expect(work.mcpServers["openmemory-work"].env.OPENMEMORY_DATA).toBe(
      "/tmp/openmemory-work",
    );
  });
});

describe("mcpServerName / mcpSnippetDataDir", () => {
  it("omits env and uses openmemory for the default directory", () => {
    expect(mcpServerName(defaultDataDir())).toBe("openmemory");
    expect(mcpSnippetDataDir(defaultDataDir())).toBeUndefined();
  });

  it("derives names for two-brain folders and sets env", () => {
    const personal = path.join(root, ".openmemory-personal");
    const work = path.join(root, ".openmemory-work");
    expect(mcpServerName(personal)).toBe("openmemory-personal");
    expect(mcpSnippetDataDir(personal)).toBe(personal);
    expect(mcpServerName(work)).toBe("openmemory-work");
    expect(mcpSnippetDataDir(work)).toBe(work);
  });

  it("prefixes a custom basename", () => {
    const dir = path.join(root, "my-memory");
    expect(mcpServerName(dir)).toBe("openmemory-my-memory");
    expect(mcpSnippetDataDir(dir)).toBe(dir);
  });

  it("does not key a non-default openmemory folder as the default store", () => {
    const dir = path.join(tmpdir(), "openmemory");
    expect(mcpServerName(dir)).toBe("openmemory-store");
    expect(mcpSnippetDataDir(dir)).toBe(dir);
  });

  it("strips a leading dot so ~/.openmemory-work is openmemory-work", () => {
    expect(mcpServerName("/tmp/.openmemory-work")).toBe("openmemory-work");
  });
});

describe("providerStatusLines", () => {
  // The failure being guarded: `cli` is the default provider, and when the CLI
  // it shells out to is absent every stage silently degrades to the heuristic
  // — which extracts no entities and does no routing. The server boots, the
  // tools answer, and the store fills with flat facts. init is where the user
  // finds out which of the two they actually got.
  const found = () => ({ command: ["claude"], available: true });
  const missing = () => ({ command: ["claude"], available: false });

  it("warns, and names the consequence, when the CLI is missing", () => {
    const text = providerStatusLines("cli", missing).join("\n");

    expect(text).toMatch(/WARNING/);
    // Naming the consequence is the point. "not found" alone tells a user
    // nothing about why they should care.
    expect(text).toMatch(/no entities/i);
    expect(text).toMatch(/no domain routing/i);
    // And both ways out.
    expect(text).toMatch(/CLAUDE_CLI_PATH/);
    expect(text).toMatch(/OPENMEMORY_PROVIDER=heuristic/);
  });

  it("confirms rather than warns when the CLI answers", () => {
    const text = providerStatusLines("cli", found).join("\n");

    expect(text).not.toMatch(/WARNING/);
    expect(text).toMatch(/claude CLI/);
  });

  it("does not probe at all when another provider is configured", () => {
    // A user who chose heuristic deliberately has nothing to be warned about,
    // and paying for a subprocess to tell them so would be worse than useless.
    let probed = false;
    const spy = () => {
      probed = true;
      return { command: ["claude"], available: false };
    };

    const text = providerStatusLines("heuristic", spy).join("\n");

    expect(probed).toBe(false);
    expect(text).not.toMatch(/WARNING/);
    expect(text).toMatch(/heuristic/);
  });
});

describe("sourcesStatusLines", () => {
  it("tells a fresh store how to turn pull on", () => {
    const text = sourcesStatusLines([]).join("\n");
    expect(text).toMatch(/pull is off/i);
    expect(text).toMatch(/claude-code/);
    expect(text).toMatch(/cursor/);
    expect(text).toMatch(/cwd/);
    expect(text).toContain("C:\\dev\\app");
    expect(text).toMatch(/openmemory pull/);
    expect(text).toMatch(/more than 50/);
    expect(text).toMatch(/openmemory consolidate/);
  });

  it("names an already-configured source", () => {
    const text = sourcesStatusLines([
      { kind: "claude-code", home: "~/.claude", cwd: "C:\\dev\\app" },
    ]).join("\n");
    expect(text).toMatch(/1 source/);
    expect(text).toMatch(/openmemory pull/);
    expect(text).toMatch(/more than 50/);
    expect(text).not.toMatch(/pull is off/i);
  });

  it("does not swallow an unknown kind", () => {
    const text = sourcesStatusLines([{ kind: "grok", home: "~/.grok" }]).join("\n");
    expect(text).toMatch(/invalid/i);
    expect(text).toMatch(/grok/);
  });
});
