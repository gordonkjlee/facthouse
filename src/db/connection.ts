/**
 * SQLite connection management via Node's built-in `node:sqlite`.
 * Synchronous — suits MCP tool handlers.
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
 * else imports the `Db` type from here, keeping the driver swappable.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

/** The database handle type. Import this rather than the driver directly. */
export type Db = DatabaseSync;

/**
 * A value bindable to a `?` placeholder. Re-exported so callers building
 * dynamic parameter lists don't have to import the driver directly.
 */
export type SqlParam = SQLInputValue;

/**
 * Open or create a SQLite database at the given path.
 * Pass ":memory:" for in-memory databases (tests).
 */
export function openDatabase(dbPath: string): Db {
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  return db;
}

/** Close the database connection. Safe to call multiple times. */
export function closeDatabase(db: Db): void {
  try {
    db.close();
  } catch {
    // Already closed — ignore.
  }
}

// ---------------------------------------------------------------------------
// Pragmas
// ---------------------------------------------------------------------------

/**
 * Read a scalar pragma (e.g. `user_version`, `data_version`).
 *
 * Returns 0 when absent or non-numeric so callers get a number without
 * repeating a type guard at every site.
 */
export function pragmaRead(db: Db, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as
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
export function pragmaWrite(db: Db, statement: string): void {
  db.exec(`PRAGMA ${statement}`);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Per-connection transaction depth, keyed by handle so that multiple open
 * databases (tests routinely open several) can't corrupt each other's nesting.
 */
const txDepth = new WeakMap<object, number>();

/**
 * Run `fn` inside a transaction: commit on success, roll back on throw, and
 * return whatever `fn` returns.
 *
 * Nested calls are promoted to SAVEPOINTs, because SQLite cannot BEGIN a
 * transaction within a transaction. This replicates what better-sqlite3's
 * `.transaction()` did implicitly, and it is load-bearing: the consolidation
 * write opens a transaction and calls findOrCreateEntity, which opens its own.
 * Without savepoint promotion that path throws.
 *
 * A failing inner block rolls back only its own work and rethrows, leaving the
 * outer transaction to decide — the same semantics as before.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
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
  if (nested) db.exec(`SAVEPOINT ${savepoint}`);
  else db.exec("BEGIN IMMEDIATE");
  txDepth.set(db, depth + 1);

  try {
    const result = fn();
    if (nested) db.exec(`RELEASE ${savepoint}`);
    else db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      if (nested) {
        // Undo this block's work, then discard the savepoint so the outer
        // transaction isn't left holding a stale entry on the stack.
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec("ROLLBACK");
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
