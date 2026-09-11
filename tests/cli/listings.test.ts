import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCKUP } from "../../src/identity.js";
import {
  LISTING_SURFACES,
  formatListingWalk,
} from "../../src/cli/listings.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("listing surfaces — one inventory", () => {
  it("lockup is npm and server.json description", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      description: string;
    };
    const server = JSON.parse(readFileSync(path.join(ROOT, "server.json"), "utf8")) as {
      description: string;
    };
    expect(LOCKUP.length).toBeLessThanOrEqual(100);
    expect(pkg.description).toBe(LOCKUP);
    expect(server.description).toBe(LOCKUP);
    const pages = readFileSync(
      path.join(ROOT, ".github/scripts/build_pages.py"),
      "utf8",
    );
    expect(pages).toContain(`PITCH = "${LOCKUP}"`);
    expect(LOCKUP).not.toMatch(/SQLite you own|you own the file/i);
  });

  it("only Cursor Directory has a client overlay", () => {
    const cursor = LISTING_SURFACES.filter((s) => s.client === "cursor");
    expect(cursor.map((s) => s.id)).toEqual(["cursor-directory"]);
    expect(cursor[0]?.channel).toBe("generated-paste");
    expect(cursor[0]?.dump).toBe("node dist/cli/cursor-listing.js");
    for (const surface of LISTING_SURFACES) {
      if (surface.id === "cursor-directory") continue;
      expect(surface.client).toBe("any");
    }
  });

  it("ids are unique and every surface has a dump", () => {
    const ids = LISTING_SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const surface of LISTING_SURFACES) {
      expect(surface.dump.length).toBeGreaterThan(0);
      expect(surface.url).toMatch(/^https:\/\//);
      expect(surface.sources.length).toBeGreaterThan(0);
    }
  });

  it("walk dump names the lockup and the Cursor dump command", () => {
    const walk = formatListingWalk();
    expect(walk).toContain(LOCKUP);
    expect(walk).toContain("node dist/cli/cursor-listing.js");
    expect(walk).toContain("client=cursor");
    expect(walk).toMatch(/Do not paste Cursor setup/);
  });
});
