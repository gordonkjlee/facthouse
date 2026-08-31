import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadConfig,
  loadShippedStoreConfig,
  configuredStorageProvider,
  assertSupportedStorage,
  unsupportedStorageMessage,
  postgresMissingUrlMessage,
  postgresInvalidUrlMessage,
  SHIPPED_STORAGE_PROVIDER,
  defaultServerConfig,
  ensureBitemporalSince,
  SYSTEM_TIME_INCOMPLETE_WARNING,
  systemTimeWarning,
} from "../src/config.js";

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

describe("storage provider", () => {
  it("defaults to sqlite", () => {
    expect(configuredStorageProvider(defaultServerConfig(), {})).toBe(
      SHIPPED_STORAGE_PROVIDER,
    );
    expect(loadConfig(dir).storage.provider).toBe("sqlite");
  });

  it("reads storage.provider from config.json", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    expect(configuredStorageProvider(loadConfig(dir), {})).toBe("postgres");
  });

  it("treats a string storage value as the provider", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: "postgres" }),
    );
    expect(configuredStorageProvider(loadConfig(dir), {})).toBe("postgres");
    expect(() => loadShippedStoreConfig(dir, {})).toThrow(postgresMissingUrlMessage());
  });

  it("lets FACTMEM_STORAGE beat OPENMEMORY_STORAGE", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "sqlite" } }),
    );
    expect(
      configuredStorageProvider(loadConfig(dir), {
        FACTMEM_STORAGE: "postgres",
        OPENMEMORY_STORAGE: "sqlite",
      }),
    ).toBe("postgres");
  });

  it("lets OPENMEMORY_STORAGE override config.json", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "sqlite" } }),
    );
    expect(
      configuredStorageProvider(loadConfig(dir), { OPENMEMORY_STORAGE: "postgres" }),
    ).toBe("postgres");
  });

  it("accepts sqlite and postgres; refuses unknown engines", () => {
    expect(() => assertSupportedStorage("sqlite")).not.toThrow();
    expect(() => assertSupportedStorage("postgres")).not.toThrow();
    expect(() => assertSupportedStorage("turso")).toThrow(
      unsupportedStorageMessage("turso"),
    );
    expect(unsupportedStorageMessage("turso")).toMatch(/SQLite was not opened/);
    expect(unsupportedStorageMessage("turso")).not.toMatch(/synchronous/);
    expect(unsupportedStorageMessage("turso")).not.toMatch(/not shipped/);
    expect(postgresMissingUrlMessage()).toMatch(/SQLite was not opened/);
    expect(postgresMissingUrlMessage()).not.toMatch(/synchronous/);
    expect(postgresMissingUrlMessage()).not.toMatch(/not shipped/);
  });

  it("does not create memory.db when postgres is requested without a URL", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    expect(() => loadShippedStoreConfig(dir, {})).toThrow(postgresMissingUrlMessage());
    expect(existsSync(path.join(dir, "memory.db"))).toBe(false);
  });

  it("loads postgres when a postgres URL is present without connecting", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    const cfg = loadShippedStoreConfig(dir, {
      OPENMEMORY_POSTGRES_URL: "postgres://USER:PASSWORD@127.0.0.1:5432/openmemory",
    });
    expect(cfg.storage.provider).toBe("postgres");
    expect(existsSync(path.join(dir, "memory.db"))).toBe(false);
  });

  it("rejects a URL that is not postgres://", () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    expect(() =>
      loadShippedStoreConfig(dir, { OPENMEMORY_POSTGRES_URL: "https://example.invalid/db" }),
    ).toThrow(postgresInvalidUrlMessage());
    expect(existsSync(path.join(dir, "memory.db"))).toBe(false);
  });
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

  it("reads optional interlocutor weights and leaves them unset otherwise", () => {
    expect(loadConfig(dir).interlocutor).toBeUndefined();
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        interlocutor: { speaker_weights: { Alex: 1.2 }, role_weights: { user: 1.1 } },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.interlocutor?.speaker_weights).toEqual({ Alex: 1.2 });
    expect(cfg.interlocutor?.role_weights).toEqual({ user: 1.1 });
    expect(cfg.extraction.enabled).toBe(true);
  });

  it("reads optional retention.disk_budget and leaves it unset otherwise", () => {
    expect(loadConfig(dir).retention.disk_budget).toBeUndefined();
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ retention: { disk_budget: "2GB" } }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.retention.disk_budget).toBe("2GB");
    expect(cfg.retention.prune_keep_per_session).toBeNull();
  });

  it("reads optional intelligence.token_budget and leaves it unset otherwise", () => {
    expect(loadConfig(dir).intelligence.token_budget).toBeUndefined();
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        intelligence: { token_budget: { cli: { week: "10M" } } },
      }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.intelligence.token_budget).toEqual({ cli: { week: "10M" } });
    expect(cfg.intelligence.provider).toBe("cli");
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
