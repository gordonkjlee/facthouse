/**
 * Current schema version. SQLite applyVN functions still write a literal N
 * so adding v19 cannot silently retarget v18. Postgres applies this value
 * in one shot.
 */
export const SCHEMA_VERSION = 18;
