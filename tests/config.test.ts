import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "om-config-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("config loader", () => {
  it("returns defaults when no config.json exists", () => {
    const cfg = loadConfig(dir);
    expect(cfg.consolidation.triggers).toEqual([
      "session_start",
      "threshold",
      "compaction",
      "shutdown",
      "manual",
    ]);
    expect(cfg.consolidation.threshold).toBe(10);
    expect(cfg.extraction.enabled).toBe(true);
  });

  it("merges user overrides onto defaults", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        consolidation: {
          triggers: ["session_start", "shutdown"],
          threshold: 5,
        },
      }),
    );
    const cfg = loadConfig(dir);
    // Override wins
    expect(cfg.consolidation.triggers).toEqual(["session_start", "shutdown"]);
    expect(cfg.consolidation.threshold).toBe(5);
    // Untouched fields keep defaults
    expect(cfg.consolidation.auto_link_events).toBe(5);
    expect(cfg.extraction.enabled).toBe(true);
  });

  it("falls back to defaults on malformed JSON", () => {
    writeFileSync(path.join(dir, "config.json"), "{ not valid json");
    const cfg = loadConfig(dir);
    expect(cfg.consolidation.triggers).toEqual([
      "session_start",
      "threshold",
      "compaction",
      "shutdown",
      "manual",
    ]);
  });

  it("deep-merges nested extraction config", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        extraction: { max_content_length: 500 },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.extraction.max_content_length).toBe(500);
    // Other extraction fields stay at defaults
    expect(cfg.extraction.enabled).toBe(true);
    expect(cfg.extraction.batch_size).toBe(50);
  });

  it("replaces (not merges) arrays when overridden", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        extraction: { roles: ["user"] },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.extraction.roles).toEqual(["user"]);
  });
});
