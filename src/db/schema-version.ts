/**
 * Current schema version. SQLite applyVN functions still write a literal N
 * so adding v23 cannot silently retarget v22. Postgres applies this value
 * in one shot.
 */
export const SCHEMA_VERSION = 23;
