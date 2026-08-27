/**
 * Postgres adapter for `Db`.
 *
 * SQLite remains the default engine. This adapter runs the same data-access
 * functions against a real Postgres — PGlite in tests, `pg` in production
 * when a store asks for it. It is not a fail-open to SQLite: if this handle
 * is in use, statements go to Postgres.
 *
 * SQL written for SQLite is rewritten at prepare/exec time: `?` becomes `$n`,
 * `INSERT OR IGNORE` becomes `ON CONFLICT DO NOTHING`, `json(?)` becomes
 * `$n::jsonb`. FTS5 MATCH is not rewritten here — keyword search picks a
 * `tsvector` query when `db.dialect === "postgres"`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, Dialect, RunResult, SqlParam, Statement } from "./connection.js";

/** Minimal backend: PGlite in tests, `pg` in production. */
export interface PostgresBackend {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function attachPostgres(backend: PostgresBackend): Db {
  return new PostgresDb(backend);
}

/**
 * Rewrite one SQLite statement into Postgres.
 * Exported so the rewrite has tests of its own, independent of an engine.
 */
export function rewriteToPostgres(sql: string): string {
  let out = sql;

  const orReplace = /INSERT\s+OR\s+REPLACE\s+INTO\s+fact_embeddings/i.test(out);
  const orIgnore = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(out);

  out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
  out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, "INSERT INTO");
  out = out.replace(/BEGIN\s+IMMEDIATE/gi, "BEGIN");
  out = out.replace(/datetime\s*\(\s*'now'\s*\)/gi, "now()");

  let n = 0;
  out = out.replace(/'[^']*'|\$[0-9]+|\?/g, (m) => {
    if (m === "?") {
      n += 1;
      return `$${n}`;
    }
    return m;
  });

  // json($1) → $1::jsonb
  out = out.replace(/json\s*\(\s*(\$\d+)\s*\)/gi, "$1::jsonb");

  if (orIgnore) {
    out = out.trimEnd().replace(/;?\s*$/, "") + " ON CONFLICT DO NOTHING";
  }
  if (orReplace) {
    out =
      out.trimEnd().replace(/;?\s*$/, "") +
      " ON CONFLICT (fact_id) DO UPDATE SET" +
      " model = EXCLUDED.model," +
      " dimensions = EXCLUDED.dimensions," +
      " vector = EXCLUDED.vector," +
      " created_at = EXCLUDED.created_at";
  }

  return out;
}

class PostgresStatement implements Statement {
  constructor(
    private readonly backend: PostgresBackend,
    private readonly sql: string,
  ) {}

  async run(...params: SqlParam[]): Promise<RunResult> {
    const result = await this.backend.query(this.sql, params as unknown[]);
    return { changes: result.rowCount, lastInsertRowid: 0 };
  }

  async get(...params: SqlParam[]): Promise<unknown> {
    const result = await this.backend.query(this.sql, params as unknown[]);
    const row = result.rows[0];
    return row === undefined ? undefined : coerceRow(row);
  }

  async all(...params: SqlParam[]): Promise<unknown[]> {
    const result = await this.backend.query(this.sql, params as unknown[]);
    return result.rows.map(coerceRow);
  }
}

class PostgresDb implements Db {
  readonly dialect: Dialect = "postgres";

  constructor(private readonly backend: PostgresBackend) {}

  async exec(sql: string): Promise<void> {
    await this.backend.exec(rewriteToPostgres(sql));
  }

  prepare(sql: string): Statement {
    return new PostgresStatement(this.backend, rewriteToPostgres(sql));
  }

  async close(): Promise<void> {
    await this.backend.close();
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return withPostgresTransaction(this, fn);
  }
}

const txDepth = new WeakMap<object, number>();
const txTail = new WeakMap<object, Promise<unknown>>();
const txContext = new AsyncLocalStorage<true>();

async function withPostgresTransaction<T>(
  db: PostgresDb,
  fn: () => Promise<T>,
): Promise<T> {
  if (txContext.getStore()) {
    return runPostgresTransaction(db, fn);
  }
  const prev = txTail.get(db) ?? Promise.resolve();
  const run = prev.then(
    () => txContext.run(true, () => runPostgresTransaction(db, fn)),
    () => txContext.run(true, () => runPostgresTransaction(db, fn)),
  );
  txTail.set(
    db,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function runPostgresTransaction<T>(
  db: PostgresDb,
  fn: () => Promise<T>,
): Promise<T> {
  const depth = txDepth.get(db) ?? 0;
  const nested = depth > 0;
  const savepoint = `om_sp_${depth}`;
  if (nested) await db.exec(`SAVEPOINT ${savepoint}`);
  else await db.exec("BEGIN");
  txDepth.set(db, depth + 1);
  try {
    const result = await fn();
    if (nested) await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    else await db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      if (nested) {
        await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else {
        await db.exec("ROLLBACK");
      }
    } catch {
      /* never mask the original error */
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

function coerceRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else {
      out[key] = value;
    }
  }
  return out;
}
