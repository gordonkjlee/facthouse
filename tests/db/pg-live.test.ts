/**
 * Live `pg` handshake. PGlite covers the dialect; this file covers the
 * shipped driver — TCP, `openStore`, schema DDL through the simple query
 * protocol.
 *
 * Local `npm test` skips when the URL is unset (no Docker required).
 * The Linux CI job sets FACTHOUSE_TEST_POSTGRES_URL and
 * FACTHOUSE_REQUIRE_POSTGRES=1, so a missing URL is a failure rather than
 * a skip. Do not key that assertion off CI=true: GitHub sets CI on every
 * runner, including Windows, which has no Postgres service. Never point this
 * at a real memory store — production reads FACTHOUSE_POSTGRES_URL, not
 * this variable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.js";
import { closeDatabase, type Db } from "../../src/db/connection.js";
import { applySchema, getSchemaVersion, SCHEMA_VERSION } from "../../src/db/schema.js";
import { openStore, SQLITE_MEMORY_FILENAME } from "../../src/db/store.js";
import { insertFact, getFact, keywordSearch } from "../../src/db/facts.js";
import { initDataDir } from "../../src/cli/init.js";

const liveUrl = process.env.FACTHOUSE_TEST_POSTGRES_URL?.trim();
const requireLive = process.env.FACTHOUSE_REQUIRE_POSTGRES === "1";

let dir: string;
let db: Db | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "om-pg-live-"));
});

afterEach(async () => {
  if (db) {
    await closeDatabase(db);
    db = undefined;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function postgresEnv(): NodeJS.ProcessEnv {
  return { FACTHOUSE_POSTGRES_URL: liveUrl as string };
}

describe("postgres live (pg)", () => {
  it("does not treat GitHub CI=true as the live-postgres require flag", () => {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(src).not.toMatch(/process\.env\.CI\s*===\s*"true"/);
    expect(src).toContain("FACTHOUSE_REQUIRE_POSTGRES");
  });

  it.skipIf(!requireLive)("FACTHOUSE_TEST_POSTGRES_URL is set in CI", () => {
    expect(liveUrl).toBeTruthy();
  });

  describe.skipIf(!liveUrl)("connector", () => {
    it("opens through openStore, applies schema, and finds a fact by keyword", async () => {
      writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ storage: { provider: "postgres" } }),
      );
      db = await openStore(dir, loadConfig(dir), postgresEnv());
      expect(db.dialect).toBe("postgres");
      expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);

      await applySchema(db);
      expect(await getSchemaVersion(db)).toBe(SCHEMA_VERSION);

      const content = `Bookings are the grain of the orders mart at Acme (${Date.now()}).`;
      const fact = await insertFact(db, {
        content,
        domain: "pipeline",
        source_type: "conversation",
      });
      const read = await getFact(db, fact.id);
      expect(read?.content).toBe(content);
      const hits = await keywordSearch(db, "bookings");
      expect(hits.map((h) => h.fact.id)).toContain(fact.id);
      expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);
    });

    it("init applies schema on the server and does not create memory.db", async () => {
      writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ storage: { provider: "postgres" } }),
      );
      const result = await initDataDir({ dataDir: dir, env: postgresEnv() });
      expect(result.dialect).toBe("postgres");
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      expect(existsSync(result.dbPath)).toBe(false);
    });
  });
});
