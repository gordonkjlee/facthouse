import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, defaultServerConfig, postgresMissingUrlMessage, postgresInvalidUrlMessage, unsupportedStorageMessage } from "../../src/config.js";
import { openStore, SQLITE_MEMORY_FILENAME } from "../../src/db/store.js";
import { closeDatabase } from "../../src/db/connection.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "om-store-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("openStore", () => {
  it("opens sqlite by default and creates memory.db", async () => {
    const db = await openStore(dir, defaultServerConfig(), {});
    try {
      expect(db.dialect).toBe("sqlite");
    } finally {
      await closeDatabase(db);
    }
    expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(true);
  });

  it("ignores OPENMEMORY_POSTGRES_URL when the engine is sqlite", async () => {
    const db = await openStore(dir, defaultServerConfig(), {
      OPENMEMORY_POSTGRES_URL: "postgres://127.0.0.1:1/none",
    });
    try {
      expect(db.dialect).toBe("sqlite");
    } finally {
      await closeDatabase(db);
    }
    expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(true);
  });

  it("throws and does not create memory.db when postgres has no URL", async () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    await expect(openStore(dir, loadConfig(dir), {})).rejects.toThrow(
      postgresMissingUrlMessage(),
    );
    expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);
  });

  it("throws and does not create memory.db when OPENMEMORY_STORAGE is postgres without a URL", async () => {
    await expect(
      openStore(dir, defaultServerConfig(), { OPENMEMORY_STORAGE: "postgres" }),
    ).rejects.toThrow(postgresMissingUrlMessage());
    expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);
  });

  it("refuses an unknown provider without opening sqlite", async () => {
    await expect(
      openStore(dir, defaultServerConfig(), { OPENMEMORY_STORAGE: "turso" }),
    ).rejects.toThrow(unsupportedStorageMessage("turso"));
    expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);
  });

  it("rejects a non-postgres URL without opening sqlite", async () => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    await expect(
      openStore(dir, loadConfig(dir), {
        OPENMEMORY_POSTGRES_URL: "mysql://127.0.0.1:3306/openmemory",
      }),
    ).rejects.toThrow(postgresInvalidUrlMessage());
    expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);
  });

  it("does not create memory.db when the postgres server cannot be reached", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    await expect(
      openStore(dir, loadConfig(dir), {
        OPENMEMORY_POSTGRES_URL: "postgres://127.0.0.1:1/openmemory",
      }),
    ).rejects.toThrow(/SQLite was not opened/);
    expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);
  });

  it("refuses a bare token_budget string without opening sqlite", async () => {
    const cfg = defaultServerConfig();
    (cfg.intelligence as { token_budget?: unknown }).token_budget = "2M";
    await expect(openStore(dir, cfg, {})).rejects.toThrow(/token_budget/);
    expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);
  });
});
