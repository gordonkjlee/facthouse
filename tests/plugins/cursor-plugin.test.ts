/**
 * Cursor and Claude Code plugin manifests, the version pin, and the
 * thin rule. One definition with the Cursor Directory rules body.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCKUP } from "../../src/identity.js";
import { CURSOR_RULES_BODY } from "../../src/cli/cursor-listing.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PLUGIN = path.join(ROOT, "plugins", "facthouse");

const PITCH =
  "Local AI memory: neuroscience-inspired Data→Information→Knowledge in SQLite you own.";

const RIVAL = /mem0|mcp\.[a-z0-9-]+\.ai|hosted openmemory/i;

const SKILLS = ["facthouse-start", "facthouse-save", "facthouse-search"] as const;

const PATH_KEYS = new Set([
  "source",
  "logo",
  "rules",
  "skills",
  "mcpServers",
  "icon",
  "commands",
  "agents",
  "hooks",
]);

interface PackageJson {
  version: string;
  description: string;
  author: string;
  license: string;
  homepage: string;
  keywords: string[];
  files: string[];
  repository: { url: string };
}

interface PluginManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: { name: string };
  homepage: string;
  repository: string;
  license: string;
  keywords: string[];
  logo?: string;
  icon?: string;
  rules?: string;
}

interface Marketplace {
  name: string;
  owner: { name: string };
  metadata?: { description: string };
  plugins: Array<{ name: string; source: string; description?: string }>;
}

interface McpFile {
  mcpServers: {
    facthouse: { command: string; args: string[]; env?: unknown };
  };
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")) as T;
}

function readText(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

function collectPaths(value: unknown, key: string | null, out: string[]): void {
  if (typeof value === "string") {
    if (key && PATH_KEYS.has(key)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, key, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectPaths(child, childKey, out);
    }
  }
}

function assertRelativePath(value: string): void {
  expect(value).not.toMatch(/^[A-Za-z]:[\\/]/);
  expect(value).not.toMatch(/^[/\\]/);
  expect(value).not.toMatch(/(^|\/)\.\.(\/|$)/);
  expect(value).not.toMatch(/\\/);
  expect(path.isAbsolute(value)).toBe(false);
  expect(value.length).toBeGreaterThan(0);
}

function frontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match?.[1]).toBeTruthy();
  const out: Record<string, string> = {};
  let key = "";
  const buf: string[] = [];
  const flush = () => {
    if (!key) return;
    out[key] = buf.join(" ").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
    buf.length = 0;
  };
  for (const line of match![1].split("\n")) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      key = field[1];
      if (field[2]) buf.push(field[2]);
    } else if (key) {
      buf.push(line.trim());
    }
  }
  flush();
  return out;
}

function ruleBody(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/);
  expect(match?.[1]).toBeTruthy();
  return match![1].replace(/\n$/, "");
}

function pluginTextFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(md|mdc|json|txt)$/i.test(entry.name)) found.push(full);
    }
  };
  walk(path.join(ROOT, "plugins"));
  return found;
}

describe("facthouse plugin manifests", () => {
  const pkg = readJson<PackageJson>("package.json");
  const cursorPlugin = readJson<PluginManifest>(
    "plugins/facthouse/.cursor-plugin/plugin.json",
  );
  const claudePlugin = readJson<PluginManifest>(
    "plugins/facthouse/.claude-plugin/plugin.json",
  );
  const cursorMarket = readJson<Marketplace>(".cursor-plugin/marketplace.json");
  const claudeMarket = readJson<Marketplace>(".claude-plugin/marketplace.json");
  const mcp = readJson<McpFile>("plugins/facthouse/mcp.json");
  const claudeMcp = readJson<McpFile>("plugins/facthouse/.mcp.json");

  it("marketplaces name facthouse and point at the plugin directory", () => {
    const { metadata, ...claudeRest } = claudeMarket;
    expect(claudeRest).toEqual(cursorMarket);
    expect(metadata).toEqual({ description: PITCH });
    expect(cursorMarket.metadata).toBeUndefined();
    expect(cursorMarket.name).toBe("facthouse");
    expect(cursorMarket.owner.name).toBe(pkg.author);
    expect(cursorMarket.plugins).toEqual([
      {
        name: "facthouse",
        source: "./plugins/facthouse",
        description: PITCH,
      },
    ]);
  });

  it("plugin manifests carry the approved pitch and shared metadata", () => {
    expect(LOCKUP).toBe(PITCH);
    expect(pkg.description).toBe(PITCH);
    const { rules, logo, ...shared } = cursorPlugin;
    expect(rules).toBe("./rules/facthouse.mdc");
    expect(logo).toBe("assets/logo.png");
    expect(cursorPlugin.icon).toBeUndefined();
    expect(claudePlugin).toEqual({ ...shared, icon: "./assets/logo.png" });
    expect(claudePlugin.logo).toBeUndefined();
    expect(claudePlugin.rules).toBeUndefined();
    expect(claudePlugin.icon).toBe("./assets/logo.png");
    expect(cursorPlugin.name).toBe("facthouse");
    expect(cursorPlugin.displayName).toBe("Facthouse");
    expect(cursorPlugin.description).toBe(PITCH);
    expect(cursorPlugin.version).toBe(pkg.version);
    expect(claudePlugin.version).toBe(pkg.version);
    expect(cursorPlugin.author).toEqual({ name: pkg.author });
    expect(cursorPlugin.homepage).toBe(pkg.homepage);
    expect(cursorPlugin.homepage).toBe("https://facthouse.dev");
    expect(cursorPlugin.repository).toBe("https://github.com/gordonkjlee/facthouse");
    expect(cursorPlugin.license).toBe(pkg.license);
    expect(cursorPlugin.keywords).toEqual(pkg.keywords);
  });

  it("keeps manifest paths relative", () => {
    for (const doc of [cursorMarket, claudeMarket, cursorPlugin, claudePlugin]) {
      const paths: string[] = [];
      collectPaths(doc, null, paths);
      expect(paths.length).toBeGreaterThan(0);
      for (const value of paths) assertRelativePath(value);
    }
  });

  it("pins npx to the package version in both MCP documents", () => {
    const pin = `@facthouse/mcp@${pkg.version}`;
    expect(mcp).toEqual(claudeMcp);
    expect(mcp.mcpServers.facthouse).toEqual({
      command: "npx",
      args: ["-y", pin],
    });
    expect(mcp.mcpServers.facthouse.env).toBeUndefined();
  });

  it("release-please bumps the pin and both manifest versions", () => {
    const config = readJson<{
      packages: { ".": { "extra-files": unknown[] } };
    }>("release-please-config.json");
    const extras = config.packages["." ]["extra-files"];
    expect(extras).toContainEqual({
      type: "json",
      path: "plugins/facthouse/mcp.json",
      jsonpath: "$.mcpServers.facthouse.args[1]",
    });
    expect(extras).toContainEqual({
      type: "json",
      path: "plugins/facthouse/.mcp.json",
      jsonpath: "$.mcpServers.facthouse.args[1]",
    });
    expect(extras).toContainEqual({
      type: "json",
      path: "plugins/facthouse/.cursor-plugin/plugin.json",
      jsonpath: "$.version",
    });
    expect(extras).toContainEqual({
      type: "json",
      path: "plugins/facthouse/.claude-plugin/plugin.json",
      jsonpath: "$.version",
    });
  });

  it("does not publish the plugin from the npm package or a repo-root MCP file", () => {
    expect(pkg.files).toEqual(["dist"]);
    expect(existsSync(path.join(ROOT, "mcp.json"))).toBe(false);
    expect(existsSync(path.join(ROOT, ".mcp.json"))).toBe(false);
    expect(existsSync(path.join(PLUGIN, "hooks"))).toBe(false);
  });

  it("copies the brand mark and keeps public copy free of rival names", () => {
    const logo = readFileSync(path.join(PLUGIN, "assets", "logo.png"));
    const mark = readFileSync(path.join(ROOT, "brand", "mark.png"));
    expect(logo.equals(mark)).toBe(true);
    const texts = pluginTextFiles();
    expect(texts.length).toBeGreaterThan(0);
    for (const file of texts) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(RIVAL);
      expect(text.toLowerCase(), file).not.toContain("day" + "book");
    }
  });
});

describe("facthouse plugin rule and skills", () => {
  it("ships the directory rule body, always on", () => {
    const text = readText("plugins/facthouse/rules/facthouse.mdc");
    const meta = frontmatter(text);
    expect(meta.description?.length).toBeGreaterThan(0);
    expect(meta.alwaysApply).toBe("true");
    expect(ruleBody(text)).toBe(CURSOR_RULES_BODY);
    expect(ruleBody(text)).toMatch(/get_session_context/);
    expect(ruleBody(text)).toMatch(/facthouse skills/);
  });

  it("skills are named facthouse-* with name and description", () => {
    const dirs = readdirSync(path.join(PLUGIN, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual([...SKILLS].sort());
    for (const name of SKILLS) {
      const text = readText(`plugins/facthouse/skills/${name}/SKILL.md`);
      const meta = frontmatter(text);
      expect(meta.name).toBe(name);
      expect(meta.name?.startsWith("facthouse-")).toBe(true);
      expect(meta.description?.length).toBeGreaterThan(0);
    }
  });

  it("start reads the store, tags the project, and skips a missing consolidate", () => {
    const text = readText("plugins/facthouse/skills/facthouse-start/SKILL.md");
    expect(text).toMatch(/get_stats/);
    expect(text).toMatch(/get_session_context/);
    expect(text).toMatch(/capture_fact/);
    expect(text).toMatch(/purpose/);
    expect(text).toMatch(/stack/);
    expect(text).toMatch(/conventions/);
    expect(text).toMatch(/how to run/);
    expect(text).toMatch(/domain_hint/);
    expect(text).toMatch(/project name/i);
    expect(frontmatter(text).description).toMatch(/first contact/i);
    expect(frontmatter(text).description).not.toMatch(/beginning work/i);
    const searchAt = text.indexOf("`search_knowledge` for the project name");
    const saveAt = text.indexOf("For each missing item, call `capture_fact`");
    expect(searchAt).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(searchAt);
    expect(text).toMatch(/already exist/);
    expect(text).toMatch(/explicitly asked to index/);
    expect(text).toMatch(/Save only what is missing/);
    expect(text).toMatch(/not registered/);
    expect(text).toMatch(/skip it/);
    expect(text).toMatch(/Do not tell the user you skipped it/);
    const initLines = text
      .split("\n")
      .filter((line) => line.includes("facthouse init"));
    expect(initLines).toEqual([
      "To copy past Cursor chats in, run `facthouse init` in a terminal and pick Cursor.",
    ]);
  });

  it("save writes one sentence and stays a correction on a copy store", () => {
    const text = readText("plugins/facthouse/skills/facthouse-save/SKILL.md");
    const meta = frontmatter(text);
    expect(meta.description).toMatch(/remember/i);
    expect(meta.description).toMatch(/save this/i);
    expect(meta.description).toMatch(/don't forget/i);
    expect(text).toMatch(/capture_fact/);
    expect(text).toMatch(/domain_hint/);
    expect(text).toMatch(/project name/i);
    expect(text).toMatch(/self-contained sentence/);
    expect(text).toMatch(/copies transcripts/);
    expect(text).toMatch(/correction/);
    expect(text).toMatch(/extraction would miss/);
    expect(text).toMatch(/Never save secrets, tokens or passwords/);
  });

  it("search uses the real read tools and says when nothing is stored", () => {
    const text = readText("plugins/facthouse/skills/facthouse-search/SKILL.md");
    const meta = frontmatter(text);
    expect(meta.description).toMatch(/previous work/i);
    expect(meta.description).toMatch(/last time/i);
    expect(text).toMatch(/search_knowledge/);
    expect(text).toMatch(/get_entity/);
    expect(text).toMatch(/get_context/);
    expect(text).toMatch(/project name/i);
    expect(text).toMatch(/Say plainly when nothing is stored/);
  });
});
