/**
 * Cursor Directory listing payload. One definition for the
 * https://cursor.directory/plugins/facthouse form.
 *
 * Dump (after build): `node dist/cli/cursor-listing.js`
 * Inventory / other surfaces: `node dist/cli/listings.js`
 * Do not add a repo-root `.mcp.json` so the directory can scrape this repo.
 * Semantic search and Postgres stay out of the paste JSON — they are store
 * knobs, not login fields.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GITHUB_REPO,
  HOMEPAGE,
  LOCKUP,
  PRODUCT_NAME,
  npmPackageSpec,
} from "../identity.js";
import { SESSION_BOOTSTRAP_INSTRUCTIONS } from "../tools/resources.js";
import { mcpConfigSnippet } from "./init.js";
import { INIT_PROMPTS, silentEmbeddingProvider } from "./init-knobs.js";
import { CURSOR_DIRECTORY_ORIGIN } from "./listings.js";
import { packageVersion } from "./package-version.js";

/** Same words as README Quick Start. `package.json` `engines.node` is the constraint. */
export const NODE_REQUIREMENT_LINE = "Needs Node 22.5 or 24+.";

export { CURSOR_DIRECTORY_ORIGIN };

/**
 * Tools-only client rules. README § Cursor / Windsurf repeats this block.
 * Cursor Directory gets it as the Rules field, not inside Setup.
 */
export const CURSOR_RULES_BODY = `When the facthouse MCP server is available:
- Before answering questions this store might already know, call search_knowledge
- To find out everything known about a particular person, project, or thing, call get_entity
- Call capture_fact only to correct or add something copy or extraction missed
- When context is getting long, call consolidate`;

export interface CursorDirectoryListing {
  origin: string;
  title: string;
  homepage: string;
  repository: string;
  description: string;
  /** Valid JSON. Default store; no env, no embedding keys. */
  mcpJson: string;
  /** Cursor-specific setup. Not an account login. Three steps. */
  setup: string;
  /** Directory Rules field. Not Setup. */
  rules: string;
}

function requiredVersion(version?: string): string {
  const resolved = version ?? packageVersion();
  if (!resolved) {
    throw new Error("package.json version is missing; cannot pin the MCP snippet");
  }
  return resolved;
}

export function cursorListingDescription(): string {
  return (
    `${LOCKUP} In Cursor it turns Agent chats into a graph of people, projects, and decisions — duplicates dropped, contradictions superseded. No account.`
  );
}

export function cursorListingMcpJson(version?: string): string {
  return mcpConfigSnippet(npmPackageSpec(requiredVersion(version)), undefined, 0);
}

export function cursorListingSetup(): string {
  if (silentEmbeddingProvider() !== null) {
    throw new Error("listing MCP JSON assumes semantic search is off by default");
  }
  return [
    `${NODE_REQUIREMENT_LINE} No Facthouse account.`,
    "",
    "1. Paste the MCP JSON into project `.cursor/mcp.json` or user `~/.cursor/mcp.json`. Keep any other servers already in that file. Restart. Settings → Tools & MCP should show Facthouse connected.",
    `2. ${SESSION_BOOTSTRAP_INSTRUCTIONS}`,
    `3. To copy Cursor transcripts automatically: ${INIT_PROMPTS.copyRecipe} Kind cursor. ${HOMEPAGE}`,
  ].join("\n");
}

export function cursorDirectoryListing(version?: string): CursorDirectoryListing {
  const pin = requiredVersion(version);
  return {
    origin: CURSOR_DIRECTORY_ORIGIN,
    title: PRODUCT_NAME,
    homepage: HOMEPAGE,
    repository: `https://github.com/${GITHUB_REPO}`,
    description: cursorListingDescription(),
    mcpJson: cursorListingMcpJson(pin),
    setup: cursorListingSetup(),
    rules: CURSOR_RULES_BODY,
  };
}

export function formatCursorDirectoryListing(
  listing: CursorDirectoryListing = cursorDirectoryListing(),
): string {
  return [
    `# Cursor Directory — paste these fields`,
    `# Live: ${listing.origin}`,
    `# Do not add a repo-root .mcp.json.`,
    `# Other listings: node dist/cli/listings.js`,
    ``,
    `## Title`,
    listing.title,
    ``,
    `## Description`,
    listing.description,
    ``,
    `## Homepage`,
    listing.homepage,
    ``,
    `## Repository`,
    listing.repository,
    ``,
    `## MCP JSON`,
    listing.mcpJson,
    ``,
    `## Setup`,
    listing.setup,
    ``,
    `## Rules`,
    listing.rules,
    ``,
  ].join("\n");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      path.normalize(fileURLToPath(import.meta.url)) ===
      path.normalize(path.resolve(entry))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.stdout.write(formatCursorDirectoryListing());
}
