/**
 * Listing surfaces — one inventory for ship, tests, and the listings skill.
 *
 * Copy on a generated-paste surface is `cursorDirectoryListing()`.
 * Lockup on package-field surfaces is `LOCKUP` in identity.ts.
 * Do not keep a second dump, a commented MCP JSON, or a Cursor overlay on a
 * client-agnostic directory.
 *
 * Dump this walk: `node dist/cli/listings.js`
 * Cursor paste payload: `node dist/cli/cursor-listing.js`
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOMEPAGE, LOCKUP, PRODUCT_SLUG } from "../identity.js";

export const CURSOR_DIRECTORY_ORIGIN =
  "https://cursor.directory/plugins/" + PRODUCT_SLUG;

export type ListingChannel =
  | "generated-paste"
  | "package-field"
  | "readme-scrape"
  | "operator-form";

export type ListingClient = "any" | "cursor";

export interface ListingSurface {
  id: string;
  name: string;
  url: string;
  channel: ListingChannel;
  /** Client overlay. Only Cursor Directory is `cursor`. */
  client: ListingClient;
  /** Repo paths whose change requires a listings walk at ship. */
  sources: readonly string[];
  /** How to produce the paste, or how the field is defined. */
  dump: string;
}

export const LISTING_SURFACES: readonly ListingSurface[] = [
  {
    id: "cursor-directory",
    name: "Cursor Directory",
    url: CURSOR_DIRECTORY_ORIGIN,
    channel: "generated-paste",
    client: "cursor",
    sources: [
      "src/cli/cursor-listing.ts",
      "src/cli/listings.ts",
      "src/identity.ts",
      "package.json",
    ],
    dump: "node dist/cli/cursor-listing.js",
  },
  {
    id: "npm",
    name: "npm package description",
    url: "https://www.npmjs.com/package/@facthouse/mcp",
    channel: "package-field",
    client: "any",
    sources: ["package.json", "src/identity.ts"],
    dump: "package.json description === LOCKUP (live on the next publish)",
  },
  {
    id: "mcp-registry",
    name: "Official MCP Registry",
    url: "https://github.com/gordonkjlee/facthouse",
    channel: "package-field",
    client: "any",
    sources: ["server.json", "src/identity.ts"],
    dump: "server.json description === LOCKUP (rides the registry publish)",
  },
  {
    id: "github-readme",
    name: "GitHub README",
    url: "https://github.com/gordonkjlee/facthouse",
    channel: "readme-scrape",
    client: "any",
    sources: ["README.md"],
    dump: "README is the voice. Directories that scrape it follow on recrawl.",
  },
  {
    id: "mcpservers-org",
    name: "mcpservers.org",
    url: "https://mcpservers.org/servers/gordonkjlee/facthouse",
    channel: "readme-scrape",
    client: "any",
    sources: ["README.md"],
    dump: "Request update on the listing after a README or pin change",
  },
  {
    id: "glama",
    name: "Glama",
    url: "https://glama.ai/mcp/servers/gordonkjlee/facthouse",
    channel: "readme-scrape",
    client: "any",
    sources: ["README.md"],
    dump: "README scrape. Do not paste Cursor setup. Their hosted how-to is not this product.",
  },
  {
    id: "pages-meta",
    name: "facthouse.dev meta / JSON-LD",
    url: HOMEPAGE,
    channel: "package-field",
    client: "any",
    sources: [".github/scripts/build_pages.py", "package.json"],
    dump: "build_pages.py PITCH === LOCKUP (meta / JSON-LD; visible lede is the README)",
  },
];

export function formatListingWalk(
  surfaces: readonly ListingSurface[] = LISTING_SURFACES,
): string {
  const lines = [
    "# Listing walk",
    `# Lockup: ${LOCKUP}`,
    "# Client overlay only when client is that directory.",
    "",
  ];
  for (const surface of surfaces) {
    lines.push(`## ${surface.id}`);
    lines.push(`${surface.name}  ${surface.channel}  client=${surface.client}`);
    lines.push(surface.url);
    lines.push(`dump: ${surface.dump}`);
    lines.push(`sources: ${surface.sources.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
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
  process.stdout.write(formatListingWalk());
}
