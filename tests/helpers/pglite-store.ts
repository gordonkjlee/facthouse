/**
 * In-process Postgres for dialect tests. PGlite is a WASM Postgres — a real
 * engine, not a SQLite stand-in. Dev-only; the shipped package does not
 * depend on it.
 */

import { PGlite } from "@electric-sql/pglite";
import { attachPostgres, type Db } from "../../src/db/index.js";
import { applySchema } from "../../src/db/schema.js";

export async function openPgliteDatabase(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;
  const db = attachPostgres({
    async query(sql, params) {
      const result = await pg.query(sql, params ?? []);
      return {
        rows: result.rows as Record<string, unknown>[],
        rowCount: result.affectedRows ?? result.rowCount ?? result.rows.length,
      };
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
  });
  await applySchema(db);
  return db;
}
