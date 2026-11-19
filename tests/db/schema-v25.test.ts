/**
 * v25 records each supersession decision. A store already at v24 gains the
 * table; a fresh store is created with it. The DDL is the same text in both
 * dialect files.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase, pragmaWrite } = await import(
  "../../src/db/connection.js"
);
const { applySchema, getSchemaVersion, SCHEMA_VERSION } = await import(
  "../../src/db/schema.js"
);
const { insertFactRelation, getFactRelationsFor } = await import(
  "../../src/db/fact-relations.js"
);
const { openPgliteDatabase } = await import("../helpers/pglite-store.js");

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
});

afterEach(async () => {
  await closeDatabase(db);
});

function factRelationsDdl(src: string): string {
  const start = src.indexOf("CREATE TABLE IF NOT EXISTS fact_relations (");
  const marker = "ON fact_relations(session_fact_id);";
  const end = src.indexOf(marker, start);
  return src.slice(start, end + marker.length);
}

async function roundTrip(database: Db): Promise<void> {
  const written = await insertFactRelation(database, {
    consolidationId: "c1",
    factId: "new-fact",
    relatedFactId: "old-fact",
    sessionFactId: "sf1",
    kind: "kept_alongside",
    contextVerdict: "different",
    factProject: "C--dev-home",
    candidateProject: "C--dev-work",
    basis: "coexists",
    reason: "both can hold",
    decidedBy: "cli",
  });
  const again = await insertFactRelation(database, {
    consolidationId: "c1",
    factId: "new-fact",
    relatedFactId: null,
    sessionFactId: "sf2",
    kind: "overlap_noted",
    contextVerdict: "different",
    factProject: null,
    candidateProject: null,
    basis: null,
    reason: "no supersession proposed; overlap 60%",
    decidedBy: "heuristic",
  });
  expect(written.id).not.toBe(again.id);

  const found = await getFactRelationsFor(database, ["new-fact", "missing"]);
  expect(found.has("missing")).toBe(false);
  const list = found.get("new-fact") ?? [];
  expect(list.map((row) => row.kind).sort()).toEqual([
    "kept_alongside",
    "overlap_noted",
  ]);
  expect(list.find((row) => row.kind === "kept_alongside")).toMatchObject({
    fact_project: "C--dev-home",
    candidate_project: "C--dev-work",
    basis: "coexists",
    decided_by: "cli",
    context_verdict: "different",
  });
  expect((await getFactRelationsFor(database, [])).size).toBe(0);
}

describe("schema v25", () => {
  it("is the current version and a fresh store has the decision table", async () => {
    await applySchema(db);
    expect(SCHEMA_VERSION).toBe(26);
    expect(await getSchemaVersion(db)).toBe(26);
    const tables = (await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fact_relations'`)
      .all()) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    await roundTrip(db);
  });

  it("creates the table when a v24 store is opened", async () => {
    await applySchema(db);
    await db.exec(`DROP TABLE fact_relations`);
    await pragmaWrite(db, "user_version = 24");
    await applySchema(db);
    expect(await getSchemaVersion(db)).toBe(26);
    const indexes = (await db.prepare(`PRAGMA index_list(fact_relations)`).all()) as Array<{
      name: string;
    }>;
    const names = indexes.map((row) => row.name);
    expect(names).toContain("idx_fact_relations_fact");
    expect(names).toContain("idx_fact_relations_related");
    expect(names).toContain("idx_fact_relations_session_fact");
    await roundTrip(db);
  });

  it("uses the same DDL in both dialect files, with no CHECK", () => {
    const sqlite = readFileSync(
      fileURLToPath(new URL("../../src/db/schema.ts", import.meta.url)),
      "utf8",
    );
    const postgres = readFileSync(
      fileURLToPath(new URL("../../src/db/postgres-schema.ts", import.meta.url)),
      "utf8",
    );
    const sqliteDdl = factRelationsDdl(sqlite);
    const postgresDdl = factRelationsDdl(postgres);
    expect(sqliteDdl).toBe(postgresDdl);
    expect(sqliteDdl).not.toMatch(/CHECK/i);
    expect(sqliteDdl).toContain("CREATE TABLE IF NOT EXISTS fact_relations");
  });
});

describe("schema v25 on Postgres", () => {
  it("reaches 25 from a store seeded at 24 and round-trips a row", async () => {
    const pg = await openPgliteDatabase();
    try {
      expect(await getSchemaVersion(pg)).toBe(26);
      await pg.exec(`DROP TABLE fact_relations`);
      await pg.exec(`DELETE FROM schema_migrations`);
      await pg.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(24);
      expect(await getSchemaVersion(pg)).toBe(24);
      await applySchema(pg);
      expect(await getSchemaVersion(pg)).toBe(26);
      const indexes = (await pg
        .prepare(
          `SELECT indexname FROM pg_indexes WHERE tablename = 'fact_relations'`,
        )
        .all()) as Array<{ indexname: string }>;
      const names = indexes.map((row) => row.indexname);
      expect(names).toContain("idx_fact_relations_fact");
      expect(names).toContain("idx_fact_relations_related");
      expect(names).toContain("idx_fact_relations_session_fact");
      await roundTrip(pg);
    } finally {
      await closeDatabase(pg);
    }
  }, 60_000);
});
