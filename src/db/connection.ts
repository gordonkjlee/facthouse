/**
 * Database handle. SQLite via Node's built-in `node:sqlite` is the shipped
 * engine; the methods are async so a later Postgres adapter can use `pg`
 * without converting callers a second time.
 *
 * Uses the built-in module rather than a native addon by necessity, not
 * preference: npm 12 made dependency lifecycle scripts opt-in, so
 * better-sqlite3's `prebuild-install || node-gyp rebuild` no longer runs and no
 * native binary is produced. The package then installs "successfully" and
 * throws "Could not locate the bindings file" at runtime. An author cannot
 * grant that approval for a user, and requiring everyone to pass
 * `--allow-scripts` would break zero-config install. A built-in module has no
 * install step to block.
 *
 * This module is the ONLY runtime coupling to the SQLite driver — everything
 * else imports `Db` from here.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";

/**
 * A value bindable to a `?` placeholder. Re-exported so callers building
 * dynamic parameter lists don't have to import the driver directly.
 */
export type SqlParam = SQLInputValue;

/** Result of a mutating statement. `changes` is always a number. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * A prepared statement. `prepare` itself is synchronous (it only holds SQL);
 * execution is async so a network engine can sit behind the same shape.
 */
export interface Statement {
  run(...params: SqlParam[]): Promise<RunResult>;
  get(...params: SqlParam[]): Promise<unknown>;
  all(...params: SqlParam[]): Promise<unknown[]>;
}

/** Which engine is behind this handle. */
export type Dialect = "sqlite" | "postgres";

/**
 * The database handle type. Import this rather than the driver directly.
 *
 * `exec` / `prepare` / transactions are the portable surface. PRAGMA helpers
 * stay SQLite-only and live beside this type.
 */
export interface Db {
  readonly dialect: Dialect;
  exec(sql: string): Promise<void>;
  prepare(sql: string): Statement;
  close(): Promise<void>;
  /**
   * Run `fn` inside a transaction: commit on success, roll back on throw.
   * Nested calls are savepoints.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

class SqliteStatement implements Statement {
  constructor(private readonly stmt: StatementSync) {}

  async run(...params: SqlParam[]): Promise<RunResult> {
    const result = this.stmt.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async get(...params: SqlParam[]): Promise<unknown> {
    return this.stmt.get(...params);
  }

  async all(...params: SqlParam[]): Promise<unknown[]> {
    return this.stmt.all(...params);
  }
}

class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  constructor(private readonly raw: DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  prepare(sql: string): Statement {
    return new SqliteStatement(this.raw.prepare(sql));
  }

  async close(): Promise<void> {
    try {
      this.raw.close();
    } catch {
      // Already closed — ignore.
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return withSqliteTransaction(this, fn);
  }
}

/**
 * Open or create a SQLite database at the given path.
 * Pass ":memory:" for in-memory databases (tests).
 *
 * Opening stays synchronous: `DatabaseSync` construction and the boot
 * PRAGMAs are local. Every statement after that is async.
 */
export function openDatabase(dbPath: string): Db {
  const raw = new DatabaseSync(dbPath);

  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");

  return new SqliteDb(raw);
}

/** Close the database connection. Safe to call multiple times. */
export async function closeDatabase(db: Db): Promise<void> {
  await db.close();
}

// ---------------------------------------------------------------------------
// Pragmas (SQLite-only)
// ---------------------------------------------------------------------------

/**
 * Read a scalar pragma (e.g. `user_version`, `data_version`).
 *
 * Returns 0 when absent or non-numeric so callers get a number without
 * repeating a type guard at every site.
 */
export async function pragmaRead(db: Db, name: string): Promise<number> {
  const row = (await db.prepare(`PRAGMA ${name}`).get()) as
    | Record<string, unknown>
    | undefined;
  const value = row?.[name];
  return typeof value === "number" ? value : 0;
}

/**
 * Write a pragma, e.g. `pragmaWrite(db, "user_version = 4")`.
 *
 * Some pragmas — notably `foreign_keys` — are silently ignored inside a
 * transaction. Schema migrations toggle it around table rebuilds and must
 * therefore stay outside one.
 */
export async function pragmaWrite(db: Db, statement: string): Promise<void> {
  await db.exec(`PRAGMA ${statement}`);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Per-connection transaction depth, keyed by handle so that multiple open
 * databases (tests routinely open several) can't corrupt each other's nesting.
 */
const txDepth = new WeakMap<object, number>();

/** Serialises top-level transactions per handle. Nested calls are savepoints. */
const txTail = new WeakMap<object, Promise<unknown>>();

/**
 * True while running inside a transaction's `fn` on this async stack.
 * Concurrent callers on the same handle also see `txDepth > 0`, so depth
 * alone cannot tell nest from overlap — two MCP tools share one connection,
 * and an await in the first would otherwise let the second BEGIN (or
 * SAVEPOINT) inside the first's work.
 */
const txContext = new AsyncLocalStorage<true>();

/**
 * Run `fn` inside a transaction: commit on success, roll back on throw, and
 * return whatever `fn` returns.
 *
 * Nested calls on the same async stack are SAVEPOINTs, because SQLite cannot
 * BEGIN a transaction within a transaction. Concurrent callers on the same
 * handle are queued instead — an await inside the first must not let the
 * second BEGIN (or SAVEPOINT) into its work. Two MCP tools share one
 * connection; this is what keeps them from interleaving.
 *
 * A failing inner block rolls back only its own work and rethrows, leaving the
 * outer transaction to decide — the same semantics as before.
 */
export async function withTransaction<T>(
  db: Db,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

async function withSqliteTransaction<T>(
  db: SqliteDb,
  fn: () => Promise<T>,
): Promise<T> {
  if (txContext.getStore()) {
    return runSqliteTransaction(db, fn);
  }
  const prev = txTail.get(db) ?? Promise.resolve();
  const run = prev.then(
    () => txContext.run(true, () => runSqliteTransaction(db, fn)),
    () => txContext.run(true, () => runSqliteTransaction(db, fn)),
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

async function runSqliteTransaction<T>(
  db: SqliteDb,
  fn: () => Promise<T>,
): Promise<T> {
  const depth = txDepth.get(db) ?? 0;
  const nested = depth > 0;
  // Name includes the depth so nested savepoints can't collide.
  const savepoint = `om_sp_${depth}`;

  // BEGIN IMMEDIATE, not BEGIN. A deferred transaction starts as a reader and
  // upgrades at the first write — and if another connection wrote in the
  // meantime, SQLite fails that upgrade with SQLITE_BUSY *immediately*, ignoring
  // busy_timeout, because waiting could deadlock two transactions each holding a
  // read lock. IMMEDIATE takes the write lock up front, where busy_timeout does
  // apply, so a concurrent writer waits its turn instead of failing.
  //
  // This matters because two AI tools legitimately share one database. Under
  // BEGIN, a capture could fail with "database is locked" purely because another
  // client's server happened to be writing — returned to the assistant as an
  // error result, not raised, so the fact was simply lost. Every caller of this
  // helper writes, so there is no read-only path to penalise.
  if (nested) await db.exec(`SAVEPOINT ${savepoint}`);
  else await db.exec("BEGIN IMMEDIATE");
  txDepth.set(db, depth + 1);

  try {
    const result = await fn();
    if (nested) await db.exec(`RELEASE ${savepoint}`);
    else await db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      if (nested) {
        // Undo this block's work, then discard the savepoint so the outer
        // transaction isn't left holding a stale entry on the stack.
        await db.exec(`ROLLBACK TO ${savepoint}`);
        await db.exec(`RELEASE ${savepoint}`);
      } else {
        await db.exec("ROLLBACK");
      }
    } catch {
      // The transaction may already have been resolved (e.g. a statement
      // aborted it). Never mask the original error with a rollback failure.
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}
