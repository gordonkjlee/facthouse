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
  cliDataArg,
  npmPackageSpec,
  pathFreeCli,
} from "../identity.js";
import { SESSION_BOOTSTRAP_INSTRUCTIONS } from "../tools/resources.js";
import { mcpConfigSnippet } from "./init.js";
import { INIT_PROMPTS, silentEmbeddingProvider } from "./init-knobs.js";
import { CURSOR_DIRECTORY_ORIGIN } from "./listings.js";
import { packageVersion } from "./package-version.js";

/** Same words as README Quick Start. `package.json` `engines.node` is the constraint. */
export const NODE_REQUIREMENT_LINE = "Needs Node 22.5 or 24+.";

/**
 * MCP-only listing store. No `FACTHOUSE_DATA` on the paste, so the server
 * is this directory. The Hooks JSON uses the same path as `--data`.
 */
export const LISTING_DEFAULT_DATA_DIR = "~/.facthouse";

export { CURSOR_DIRECTORY_ORIGIN };

/**
 * Tools-only client rules. README § Cursor / Windsurf repeats this block.
 * Cursor Directory gets it as the Rules field, not inside Setup.
 * First bullet is `SESSION_BOOTSTRAP_INSTRUCTIONS` — one definition.
 */
export const CURSOR_RULES_BODY = `When the facthouse MCP server is available:
- ${SESSION_BOOTSTRAP_INSTRUCTIONS}
- Before answering questions this store might already know, call search_knowledge
- To find out everything known about a particular person, project, or thing, call get_entity
- Call capture_fact only to correct or add something copy or extraction missed`;

export interface CursorDirectoryListing {
  origin: string;
  title: string;
  homepage: string;
  repository: string;
  description: string;
  /** Valid JSON. Default store; no env, no embedding keys. */
  mcpJson: string;
  /** Cursor-specific setup. Not an account login. */
  setup: string;
  /** Directory Rules field. Not Setup. */
  rules: string;
  /**
   * Directory Hooks tab. Copy into `~/.cursor/hooks.json` — that tab is
   * Copy, not Add to Cursor.
   */
  hooks: string;
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
    `${LOCKUP} In Cursor it turns Agent chats into a graph of people, projects, and decisions — duplicates dropped, contradictions superseded. ` +
    `Click Add to Cursor on the MCP server and on the rule. ${NODE_REQUIREMENT_LINE} ` +
    `No account and no init; the store is ${LISTING_DEFAULT_DATA_DIR}. ` +
    `Copy transcripts: ${INIT_PROMPTS.copyRecipe} Kind cursor. ` +
    `Compaction: copy the Hooks tab into ~/.cursor/hooks.json.`
  );
}

export function cursorListingMcpJson(version?: string): string {
  return mcpConfigSnippet(npmPackageSpec(requiredVersion(version)), undefined, 0);
}

/**
 * Same argv as init `precompactHookJson` (`notify compaction --data`).
 * Cursor Directory Hooks are Copy, not an installed plugin script.
 */
export function cursorListingHookCommand(version?: string): string {
  return pathFreeCli(
    `notify compaction --data ${cliDataArg(LISTING_DEFAULT_DATA_DIR)}`,
    npmPackageSpec(requiredVersion(version)),
  );
}

export function cursorListingHooksJson(version?: string): string {
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        preCompact: [{ command: cursorListingHookCommand(version) }],
      },
    },
    null,
    2,
  );
}

export function cursorListingSetup(): string {
  if (silentEmbeddingProvider() !== null) {
    throw new Error("listing MCP JSON assumes semantic search is off by default");
  }
  return [
    `${NODE_REQUIREMENT_LINE} No Facthouse account.`,
    "",
    `1. Click Add to Cursor on the MCP server, then on the rule. Restart. Settings → Tools & MCP should show Facthouse connected. The store is ${LISTING_DEFAULT_DATA_DIR} — no init.`,
    `2. Optional — copy Agent transcripts automatically: ${INIT_PROMPTS.copyRecipe} Kind cursor. ${HOMEPAGE}`,
    `3. Optional — before compact: copy the Hooks JSON into ~/.cursor/hooks.json (we do not install it). --data is ${LISTING_DEFAULT_DATA_DIR} so it matches the MCP default. Hooks do not see mcp.json env.`,
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
    hooks: cursorListingHooksJson(pin),
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
    `## Hooks`,
    listing.hooks,
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
