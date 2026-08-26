import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ensureBitemporalSince, SYSTEM_TIME_INCOMPLETE_WARNING, systemTimeWarning } from "../src/config.js";

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
    expect(cfg.inferences.enabled).toBe(false);
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

  it("defaults sources to an empty list — pull is off", () => {
    const cfg = loadConfig(dir);
    expect(cfg.sources).toEqual([]);
  });

  it("replaces sources with a named claude-code home", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        sources: [{ kind: "claude-code", home: "~/.claude", cwd: "C:\\dev\\app" }],
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.sources).toEqual([
      { kind: "claude-code", home: "~/.claude", cwd: "C:\\dev\\app" },
    ]);
    // Untouched fields keep defaults — a source list is not a licence to
    // change how capture_fact works.
    expect(cfg.extraction.enabled).toBe(true);
    expect(cfg.consolidation.threshold).toBe(10);
  });
});

describe("ensureBitemporalSince", () => {
  it("does not stamp simple mode", () => {
    const cfg = ensureBitemporalSince(dir, loadConfig(dir));
    expect(cfg.temporal.mode).toBe("simple");
    expect(cfg.temporal.bitemporal_since).toBeNull();
    expect(existsSync(path.join(dir, "config.json"))).toBe(false);
  });

  it("stamps bitemporal_since once when switching to bitemporal", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ temporal: { mode: "bitemporal" } }),
    );
    const first = ensureBitemporalSince(dir, loadConfig(dir));
    expect(first.temporal.mode).toBe("bitemporal");
    expect(first.temporal.bitemporal_since).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
    );
    const written = JSON.parse(
      readFileSync(path.join(dir, "config.json"), "utf-8"),
    );
    expect(written.temporal.mode).toBe("bitemporal");
    expect(written.temporal.bitemporal_since).toBe(first.temporal.bitemporal_since);

    const second = ensureBitemporalSince(dir, loadConfig(dir));
    expect(second.temporal.bitemporal_since).toBe(first.temporal.bitemporal_since);
  });

  it("leaves an existing stamp alone", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        temporal: { mode: "bitemporal", bitemporal_since: "2024-01-01T00:00:00.000Z" },
      }),
    );
    const cfg = ensureBitemporalSince(dir, loadConfig(dir));
    expect(cfg.temporal.bitemporal_since).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("systemTimeWarning", () => {
  it("warns when T is before the stamp or the stamp is missing", () => {
    expect(systemTimeWarning("2020-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")).toBe(
      SYSTEM_TIME_INCOMPLETE_WARNING,
    );
    expect(systemTimeWarning("2024-06-01T00:00:00.000Z", null)).toBe(
      SYSTEM_TIME_INCOMPLETE_WARNING,
    );
    expect(systemTimeWarning("2024-06-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")).toBeNull();
  });
});
