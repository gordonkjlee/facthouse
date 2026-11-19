/**
 * v26 records the consolidation lease heartbeat separately from run start.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase, pragmaWrite } = await import(
  "../../src/db/connection.js"
);
const { applySchema, getSchemaVersion, SCHEMA_VERSION } = await import(
  "../../src/db/schema.js"
);
const { openPgliteDatabase } = await import("../helpers/pglite-store.js");

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("schema v26", () => {
  it("is the current version and a fresh store has heartbeat_at", async () => {
    await applySchema(db);
    expect(SCHEMA_VERSION).toBe(26);
    expect(await getSchemaVersion(db)).toBe(26);
    const cols = (await db.prepare(`PRAGMA table_info(consolidation_lock)`).all()) as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("heartbeat_at");
  });

  it("adds heartbeat_at when a v25 store is opened", async () => {
    await applySchema(db);
    await db.exec(`ALTER TABLE consolidation_lock DROP COLUMN heartbeat_at`);
    await pragmaWrite(db, "user_version = 25");
    await db.prepare(
      `INSERT INTO consolidation_lock (id, holder, started_at) VALUES (1, ?, ?)`,
    ).run("prior", "2020-01-01T00:00:00.000Z");
    await applySchema(db);
    expect(await getSchemaVersion(db)).toBe(26);
    const row = (await db
      .prepare(`SELECT heartbeat_at FROM consolidation_lock WHERE id = 1`)
      .get()) as { heartbeat_at: string };
    expect(row.heartbeat_at).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("schema v26 on Postgres", () => {
  it("adds heartbeat_at to a store seeded at v25", async () => {
    const pg = await openPgliteDatabase();
    try {
      expect(await getSchemaVersion(pg)).toBe(SCHEMA_VERSION);
      await pg.exec(`ALTER TABLE consolidation_lock DROP COLUMN heartbeat_at`);
      await pg.exec(`DELETE FROM schema_migrations`);
      await pg.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(25);
      await pg.prepare(
        `INSERT INTO consolidation_lock (id, holder, started_at) VALUES (1, ?, ?)`,
      ).run("prior", "2020-01-01T00:00:00.000Z");
      await applySchema(pg);
      expect(await getSchemaVersion(pg)).toBe(SCHEMA_VERSION);
      const row = (await pg
        .prepare(`SELECT heartbeat_at FROM consolidation_lock WHERE id = 1`)
        .get()) as { heartbeat_at: string };
      expect(row.heartbeat_at).toContain("2020-01-01");
    } finally {
      await closeDatabase(pg);
    }
  }, 60_000);
});
