/**
 * Current schema version. SQLite applyVN functions still write a literal N
 * so adding v21 cannot silently retarget v20. Postgres applies this value
 * in one shot.
 */
export const SCHEMA_VERSION = 21;
