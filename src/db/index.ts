/**
 * Barrel re-export for the database layer.
 */

export {
  openDatabase,
  closeDatabase,
  withTransaction,
  pragmaRead,
  pragmaWrite,
} from "./connection.js";
export type { Db, Dialect } from "./connection.js";
export { applySchema, getSchemaVersion, SCHEMA_VERSION } from "./schema.js";
export { attachPostgres, rewriteToPostgres } from "./postgres.js";
export type { PostgresBackend } from "./postgres.js";
export { openStore, sqliteMemoryPath, SQLITE_MEMORY_FILENAME } from "./store.js";
export {
  createSession,
  ensureSession,
  updateLastActivity,
  getSession,
  getLatestSession,
  insertEvent,
  getEventById,
  getEvents,
  getEventCount,
  conversationRef,
} from "./sessions.js";
export type {
  NewSession,
  NewSessionEvent,
  GetEventsOpts,
  ConversationRef,
} from "./sessions.js";
export * from "./session-facts.js";
export * from "./facts.js";
export * from "./entities.js";
export * from "./domains.js";
export * from "./consolidation-lock.js";
export * from "./sources.js";
export * from "./watermarks.js";
export * from "./extract-watermarks.js";
export * from "./consolidations.js";
export * from "./stats.js";
export * from "./intelligence-runs.js";
export * from "./inferences.js";
export * from "./disk-budget.js";
export * from "./prune.js";
