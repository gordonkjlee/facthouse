/**
 * Renamed config keys keep working for a store written by an earlier release.
 * `intelligence.cli.graduate_model` became `integrate_model` with the
 * copy / extract / integrate vocabulary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, honourLegacyConfigKeys } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "om-legacy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("intelligence.cli.graduate_model", () => {
  it("is read as integrate_model when only the old key is present", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ intelligence: { cli: { graduate_model: "sonnet" } } }),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = loadConfig(dir);
    expect(cfg.intelligence.cli?.integrate_model).toBe("sonnet");
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/graduate_model is now/));
  });

  it("the new key wins when both are present", () => {
    const doc = {
      intelligence: { cli: { graduate_model: "old", integrate_model: "new" } },
    };
    honourLegacyConfigKeys(doc);
    expect(doc.intelligence.cli.integrate_model).toBe("new");
  });

  it("leaves a document without the old key alone", () => {
    const doc = { intelligence: { cli: { model: "haiku" } } };
    expect(honourLegacyConfigKeys(doc)).toBe(doc);
    expect(doc.intelligence.cli).toEqual({ model: "haiku" });
  });

  it("tolerates non-object input", () => {
    expect(honourLegacyConfigKeys(null)).toBeNull();
    expect(honourLegacyConfigKeys("x")).toBe("x");
    expect(honourLegacyConfigKeys({ intelligence: { cli: 3 } })).toEqual({
      intelligence: { cli: 3 },
    });
  });
});
