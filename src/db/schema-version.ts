/**
 * Current schema version. SQLite applyVN functions still write a literal N
 * so adding v20 cannot silently retarget v19. Postgres applies this value
 * in one shot.
 */
export const SCHEMA_VERSION = 20;
