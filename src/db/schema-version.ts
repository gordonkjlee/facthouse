/**
 * Current schema version. SQLite applyVN functions still write a literal N
 * so adding v22 cannot silently retarget v21. Postgres applies this value
 * in one shot.
 */
export const SCHEMA_VERSION = 22;
