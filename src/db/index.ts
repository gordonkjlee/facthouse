/**
 * Barrel re-export for the database layer.
 */

export { openDatabase, closeDatabase } from "./connection.js";
export { applySchema, getSchemaVersion } from "./schema.js";
export {
  createSession,
  updateLastActivity,
  getSession,
  getLatestSession,
  insertEvent,
  getEvents,
  getEventCount,
} from "./sessions.js";
export type { NewSession, NewSessionEvent, GetEventsOpts } from "./sessions.js";
