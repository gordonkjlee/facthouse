import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";


const { initDataDir, mcpConfigSnippet, providerStatusLines } = await import("../../src/cli/init.js");
const { CONFIG_FILENAME, loadConfig, defaultServerConfig } = await import("../../src/config.js");

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "om-init-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("initDataDir", () => {
  it("creates the data dir, database with schema, and default config", () => {
    const dataDir = path.join(root, "fresh");
    const result = initDataDir({ dataDir });

    expect(result.createdDataDir).toBe(true);
    expect(result.wroteConfig).toBe(true);
    expect(result.configPreserved).toBe(false);
    expect(existsSync(result.dbPath)).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
    // Schema actually applied, not just an empty file.
    expect(result.schemaVersion).toBeGreaterThan(0);
  });

  it("writes a config.json that round-trips to the shipped defaults", () => {
    const dataDir = path.join(root, "cfg");
    initDataDir({ dataDir });

    const written = JSON.parse(
      readFileSync(path.join(dataDir, CONFIG_FILENAME), "utf-8"),
    );
    expect(written).toEqual(defaultServerConfig());
    // Loading it back yields the same effective config as the defaults.
    expect(loadConfig(dataDir)).toEqual(defaultServerConfig());
  });

  it("surfaces the tunable knobs users otherwise can't discover", () => {
    const dataDir = path.join(root, "knobs");
    initDataDir({ dataDir });
    const written = JSON.parse(
      readFileSync(path.join(dataDir, CONFIG_FILENAME), "utf-8"),
    );
    expect(written.intelligence.provider).toBe("cli");
    expect(written.intelligence.fallback).toBe("heuristic");
    expect(written.consolidation.triggers).toBeInstanceOf(Array);
    expect(written.extraction).toHaveProperty("enabled");
    expect(written.retention).toHaveProperty("prune_keep_per_session");
  });

  it("is idempotent — a second run preserves an edited config", () => {
    const dataDir = path.join(root, "again");
    initDataDir({ dataDir });

    // Simulate the user tuning their config.
    const configPath = path.join(dataDir, CONFIG_FILENAME);
    const edited = { ...defaultServerConfig(), consolidation: { triggers: ["manual"], threshold: 99, auto_link_events: 1 } };
    writeFileSync(configPath, JSON.stringify(edited, null, 2), "utf-8");

    const second = initDataDir({ dataDir });
    expect(second.createdDataDir).toBe(false);
    expect(second.wroteConfig).toBe(false);
    expect(second.configPreserved).toBe(true);

    // The user's edit survived.
    const after = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(after.consolidation.threshold).toBe(99);
  });

  it("--force resets an existing config back to defaults", () => {
    const dataDir = path.join(root, "forced");
    initDataDir({ dataDir });
    const configPath = path.join(dataDir, CONFIG_FILENAME);
    writeFileSync(configPath, JSON.stringify({ intelligence: { provider: "heuristic" } }), "utf-8");

    const forced = initDataDir({ dataDir, force: true });
    expect(forced.wroteConfig).toBe(true);
    expect(forced.configPreserved).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual(defaultServerConfig());
  });

  it("re-running preserves existing data (does not recreate the database)", async () => {
    const dataDir = path.join(root, "data");
    initDataDir({ dataDir });

    const m: any = await import("../../src/db/index.js");
    const dbPath = path.join(dataDir, "memory.db");

    const db = m.openDatabase(dbPath);
    m.createSession(db, { source_tool: "test", project: null });
    m.closeDatabase(db);

    const second = initDataDir({ dataDir });
    expect(second.createdDataDir).toBe(false);

    const db2 = m.openDatabase(dbPath);
    const count = db2.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    m.closeDatabase(db2);
    expect(count.n).toBe(1);
  });

  it("creates nested data directories that don't exist yet", () => {
    const dataDir = path.join(root, "deeply", "nested", "dir");
    const result = initDataDir({ dataDir });
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
