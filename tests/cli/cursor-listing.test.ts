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
  NODE_REQUIREMENT_LINE,
  cursorDirectoryListing,
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

  it("description is lockup plus a Cursor consequence, not pipeline jargon", () => {
    expect(listing.description.startsWith(LOCKUP)).toBe(true);
    expect(listing.description).toMatch(/In Cursor/);
    expect(listing.description).toMatch(/No account/);
    expect(listing.description).not.toMatch(/JSONL|record store|SQLite you own|you own the file|Mem0|openmemory/i);
  });

  it("setup is three Cursor steps, not a README dump", () => {
    expect(listing.setup).toContain(NODE_REQUIREMENT_LINE);
    expect(listing.setup).toContain(".cursor/mcp.json");
    expect(listing.setup).toContain("~/.cursor/mcp.json");
    expect(listing.setup).toContain(SESSION_BOOTSTRAP_INSTRUCTIONS);
    expect(listing.setup).toContain(INIT_PROMPTS.copyRecipe);
    expect(listing.setup).toContain("Kind cursor");
    expect(listing.setup).toContain(HOMEPAGE);
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

  it("rules are a separate field frozen against the README Cursor block", () => {
    expect(listing.rules).toBe(CURSOR_RULES_BODY);
    expect(readmeText()).toContain(CURSOR_RULES_BODY);
    expect(readmeText()).toContain(NODE_REQUIREMENT_LINE);
    expect(readmeText()).toMatch(/kind: "cursor"/);
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

  it("dump is pasteable labelled fields, including Rules", () => {
    const dump = formatCursorDirectoryListing(listing);
    expect(dump).toContain(listing.mcpJson);
    expect(dump).toContain(listing.setup);
    expect(dump).toContain(listing.rules);
    expect(dump).toMatch(/^## Rules$/m);
    expect(dump).toContain("Do not add a repo-root .mcp.json");
    expect(dump).toContain(listing.origin);
  });
});
