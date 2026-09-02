/**
 * Current schema version. SQLite applyVN functions still write a literal N
 * so adding v24 cannot silently retarget v23. Postgres applies this value
 * in one shot.
 */
export const SCHEMA_VERSION = 24;
