/**
 * v24 renames consolidations.facts_graduated → facts_integrated. A store from
 * an earlier release carries the old name; a fresh store never had it. Both
 * must open at v24 with the data intact.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase, pragmaWrite } = await import(
  "../../src/db/connection.js"
);
const { applySchema, getSchemaVersion, SCHEMA_VERSION } = await import(
  "../../src/db/schema.js"
);

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
});

afterEach(async () => {
  await closeDatabase(db);
});

async function columns(): Promise<string[]> {
  const rows = (await db.prepare(`PRAGMA table_info(consolidations)`).all()) as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

describe("schema v24", () => {
  it("is the current version and a fresh store has facts_integrated", async () => {
    await applySchema(db);
    expect(SCHEMA_VERSION).toBe(24);
    expect(await getSchemaVersion(db)).toBe(24);
    expect(await columns()).toContain("facts_integrated");
    expect(await columns()).not.toContain("facts_graduated");
  });

  it("renames the column on a store that still has the old name and keeps its data", async () => {
    await applySchema(db);
    // Rewind to what a 0.25 store looks like: old column name, user_version 23.
    await db.exec(
      `ALTER TABLE consolidations RENAME COLUMN facts_integrated TO facts_graduated`,
    );
    await db.prepare(
      `INSERT INTO consolidations
         (id, session_id, facts_in, facts_graduated, facts_rejected,
          entities_created, entities_linked, supersessions,
          summary, open_threads, last_event_sequence, created_at)
       VALUES ('c-old', NULL, 3, 2, 1, 0, 0, 0, NULL, NULL, 9, ?)`,
    ).run(new Date().toISOString());
    await pragmaWrite(db, "user_version = 23");

    await applySchema(db);

    expect(await getSchemaVersion(db)).toBe(24);
    expect(await columns()).toContain("facts_integrated");
    expect(await columns()).not.toContain("facts_graduated");
    const row = (await db
      .prepare(`SELECT facts_integrated FROM consolidations WHERE id = 'c-old'`)
      .get()) as { facts_integrated: number };
    expect(row.facts_integrated).toBe(2);
  });

  it("is idempotent when the column was already renamed", async () => {
    await applySchema(db);
    await pragmaWrite(db, "user_version = 23");
    await applySchema(db);
    expect(await getSchemaVersion(db)).toBe(24);
    expect(await columns()).toContain("facts_integrated");
  });
});
