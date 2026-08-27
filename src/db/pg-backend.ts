/**
 * Production Postgres backend: the `pg` driver over TCP.
 *
 * Loaded only when a store asks for postgres. PGlite stays a test engine and
 * never goes through this file. `pg` is JavaScript talking to a server, not a
 * native addon — the same reason the SQLite path uses Node's built-in module.
 */

import { Client } from "pg";
import { attachPostgres, type PostgresBackend } from "./postgres.js";
import type { Db } from "./connection.js";

/** Handshake wait so a down server dies instead of hanging the MCP process. */
const CONNECT_TIMEOUT_MS = 10_000;

class PgClientBackend implements PostgresBackend {
  constructor(private readonly client: Client) {}

  async query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    // No parameters → simple query protocol, which can run the multi-statement
    // DDL `applyPostgresSchema` sends. Parameterised queries are one statement.
    const result =
      params !== undefined && params.length > 0
        ? await this.client.query(sql, params)
        : await this.client.query(sql);
    return {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

/**
 * Connect a single `pg` client and wrap it as `Db`. Caller applies schema.
 * On handshake failure the client is closed before the error is rethrown.
 */
export async function connectPostgres(url: string): Promise<Db> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return attachPostgres(new PgClientBackend(client));
}
