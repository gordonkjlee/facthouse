/**
 * Current schema version. SQLite applyVN functions still write a literal N
 * so adding v18 cannot silently retarget v17. Postgres applies this value
 * in one shot.
 */
export const SCHEMA_VERSION = 17;
