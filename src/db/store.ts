/**
 * Open the store this data directory asked for.
 *
 * SQLite is the default and creates `memory.db` in the directory. Postgres
 * is reached only when the store names it, via `OPENMEMORY_POSTGRES_URL`.
 * A missing URL or a failed handshake does not open SQLite — that would be
 * fail-open.
 */

import path from "node:path";
import { openDatabase, type Db } from "./connection.js";
import {
  assertSupportedStorage,
  configuredStorageProvider,
  postgresConnectFailedMessage,
  postgresUrlOrThrow,
} from "../config.js";
import type { ServerConfig } from "../types/config.js";

/** Filename of the SQLite file when that engine is selected. One definition. */
export const SQLITE_MEMORY_FILENAME = "memory.db";

export function sqliteMemoryPath(dataDir: string): string {
  return path.join(dataDir, SQLITE_MEMORY_FILENAME);
}

/**
 * Connect the engine `config` / `env` selected. Does not apply schema —
 * callers do, same as `openDatabase`.
 */
export async function openStore(
  dataDir: string,
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Db> {
  const provider = configuredStorageProvider(config, env);
  assertSupportedStorage(provider);
  if (provider === "sqlite") {
    return openDatabase(sqliteMemoryPath(dataDir));
  }
  const url = postgresUrlOrThrow(env);
  try {
    const { connectPostgres } = await import("./pg-backend.js");
    return await connectPostgres(url);
  } catch (err) {
    throw new Error(postgresConnectFailedMessage(err), { cause: err });
  }
}
