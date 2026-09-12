import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GITHUB_REPO,
  HOMEPAGE,
  LOCKUP,
  NPM_PACKAGE,
  PRODUCT_NAME,
  npmPackageSpec,
} from "../../src/identity.js";
import { SESSION_BOOTSTRAP_INSTRUCTIONS } from "../../src/tools/resources.js";
import { mcpConfigSnippet } from "../../src/cli/init.js";
import { INIT_PROMPTS, silentEmbeddingProvider } from "../../src/cli/init-knobs.js";
import {
  CURSOR_DIRECTORY_ORIGIN,
  CURSOR_RULES_BODY,
  LISTING_DEFAULT_DATA_DIR,
  NODE_REQUIREMENT_LINE,
  cursorDirectoryListing,
  cursorListingHookCommand,
  cursorListingHooksJson,
  cursorListingMcpJson,
  formatCursorDirectoryListing,
} from "../../src/cli/cursor-listing.js";
import { packageVersion } from "../../src/cli/package-version.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function readmeText(): string {
  return readFileSync(path.join(ROOT, "README.md"), "utf-8").replace(/\r\n/g, "\n");
}

describe("cursor directory listing — one definition", () => {
  const version = packageVersion();
  if (!version) throw new Error("package.json version missing");
  const listing = cursorDirectoryListing(version);
  const parsed = JSON.parse(listing.mcpJson) as {
    mcpServers: Record<string, { command: string; args: string[]; env?: unknown }>;
  };

  it("pins the published package via mcpConfigSnippet, with no env", () => {
    expect(listing.mcpJson).toBe(mcpConfigSnippet(npmPackageSpec(version), undefined, 0));
    expect(listing.mcpJson).toBe(cursorListingMcpJson(version));
    expect(parsed.mcpServers.facthouse).toEqual({
      command: "npx",
      args: ["-y", `${NPM_PACKAGE}@${version}`],
    });
    expect(parsed.mcpServers.facthouse.env).toBeUndefined();
  });

  it("MCP JSON is strict JSON: no comments, placeholders, or embedding keys", () => {
    expect(listing.mcpJson).not.toMatch(/\/\//);
    expect(listing.mcpJson).not.toMatch(/\/\*/);
    expect(listing.mcpJson).not.toMatch(/YOUR_/i);
    expect(listing.mcpJson).not.toMatch(/VOYAGE/);
    expect(listing.mcpJson).not.toMatch(/EMBEDDING/);
    expect(listing.mcpJson).not.toMatch(/placeholder/i);
    expect(listing.mcpJson).not.toMatch(/FACTHOUSE_/);
    expect(silentEmbeddingProvider()).toBeNull();
    expect(DEFAULT_CONFIG.embedding.provider).toBeNull();
  });

  it("description tells Directory users Add to Cursor is enough for a record store", () => {
    expect(listing.description.startsWith(LOCKUP)).toBe(true);
    expect(listing.description).toMatch(/In Cursor/);
    expect(listing.description).toMatch(/Add to Cursor/);
    expect(listing.description).toContain(NODE_REQUIREMENT_LINE);
    expect(listing.description).toContain(LISTING_DEFAULT_DATA_DIR);
    expect(listing.description).toMatch(/no init/i);
    expect(listing.description).toContain(INIT_PROMPTS.copyRecipe);
    expect(listing.description).toMatch(/Kind cursor/);
    expect(listing.description).toMatch(/Hooks tab/);
    expect(listing.description).not.toMatch(/JSONL|record store|SQLite you own|you own the file|Mem0|openmemory/i);
  });

  it("setup is Add to Cursor, then optional copy and hook, not a README dump", () => {
    expect(listing.setup).toContain(NODE_REQUIREMENT_LINE);
    expect(listing.setup).toMatch(/Add to Cursor/);
    expect(listing.setup).toContain(LISTING_DEFAULT_DATA_DIR);
    expect(listing.setup).toContain(INIT_PROMPTS.copyRecipe);
    expect(listing.setup).toContain("Kind cursor");
    expect(listing.setup).toContain(HOMEPAGE);
    expect(listing.setup).toMatch(/~\/\.cursor\/hooks\.json/);
    expect(listing.setup).toMatch(/we do not install it/);
    expect(listing.setup).toMatch(/No Facthouse account/);
    expect(listing.setup).not.toMatch(/npm install -g/);
    expect(listing.setup).not.toMatch(/see CLI below/);
    expect(listing.setup).not.toMatch(/Composer SQLite/);
    expect(listing.setup).not.toMatch(/agent-transcripts/);
    expect(listing.setup).not.toMatch(/embedding keys/);
    expect(listing.setup).not.toMatch(/When the facthouse MCP server is available/);
    const numbered = listing.setup.match(/^\d+\. /gm) ?? [];
    expect(numbered).toEqual(["1. ", "2. ", "3. "]);
  });

  it("rules lead with session bootstrap and freeze against the README Cursor block", () => {
    expect(listing.rules).toBe(CURSOR_RULES_BODY);
    expect(listing.rules).toContain(SESSION_BOOTSTRAP_INSTRUCTIONS);
    expect(listing.rules).not.toMatch(/When context is getting long/);
    expect(listing.rules).not.toMatch(/call consolidate/);
    expect(readmeText()).toContain(CURSOR_RULES_BODY);
    expect(readmeText()).toContain(NODE_REQUIREMENT_LINE);
    expect(readmeText()).toMatch(/kind: "cursor"/);
    expect(readmeText()).toMatch(/Add to Cursor/);
    expect(readmeText()).toMatch(/per component/);
  });

  it("hooks JSON is Cursor preCompact, path-free CLI, default store --data", () => {
    expect(listing.hooks).toBe(cursorListingHooksJson(version));
    const parsed = JSON.parse(listing.hooks) as {
      version: number;
      hooks: { preCompact: { command: string }[] };
    };
    expect(parsed.version).toBe(1);
    const command = parsed.hooks.preCompact[0]?.command;
    expect(command).toBe(cursorListingHookCommand(version));
    expect(command).toContain("notify compaction");
    expect(command).toContain(`--data ${LISTING_DEFAULT_DATA_DIR}`);
    expect(command).toMatch(/npx -y -p "@facthouse\/mcp@/);
    expect(command).toContain("-- facthouse ");
    expect(command).not.toMatch(/npx -y @facthouse\/mcp[^\s]/);
    expect(listing.hooks).not.toMatch(/YOUR_/i);
    expect(listing.hooks).not.toMatch(/PreCompact/);
    expect(listing.hooks).not.toMatch(/CURSOR_PLUGIN_ROOT/);
  });

  it("identity and dump fields match package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      homepage: string;
      engines: { node: string };
      version: string;
    };
    expect(listing.title).toBe(PRODUCT_NAME);
    expect(listing.homepage).toBe(HOMEPAGE);
    expect(listing.homepage).toBe(pkg.homepage);
    expect(listing.repository).toBe(`https://github.com/${GITHUB_REPO}`);
    expect(listing.origin).toBe(CURSOR_DIRECTORY_ORIGIN);
    expect(pkg.engines.node).toBe("^22.5.0 || >=24.0.0");
    expect(pkg.version).toBe(version);
  });

  it("dump is pasteable labelled fields, including Rules and Hooks", () => {
    const dump = formatCursorDirectoryListing(listing);
    expect(dump).toContain(listing.mcpJson);
    expect(dump).toContain(listing.setup);
    expect(dump).toContain(listing.rules);
    expect(dump).toContain(listing.hooks);
    expect(dump).toMatch(/^## Rules$/m);
    expect(dump).toMatch(/^## Hooks$/m);
    expect(dump).toContain("Do not add a repo-root .mcp.json");
    expect(dump).toContain(listing.origin);
  });
});
