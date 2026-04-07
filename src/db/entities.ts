/**
 * Data access for entities and the knowledge graph.
 * All functions are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Entity, EntityEdge } from "../types/data.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface NewEntity {
  type: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Find an entity by name, optionally filtered by type. Uses canonical_name for matching.
 *  Without type, returns first match — non-deterministic if multiple entities share a canonical name. */
export function findEntity(
  db: Database.Database,
  name: string,
  type?: string,
): Entity | null {
  const canonical = name.toLowerCase().trim();
  let sql = `SELECT * FROM entities WHERE canonical_name = ?`;
  const params: unknown[] = [canonical];

  if (type !== undefined) {
    sql += ` AND type = ?`;
    params.push(type);
  }

  const row = db.prepare(sql).get(...params) as
    | (Omit<Entity, "metadata"> & { metadata: string | null })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}

/** Find an entity by exact canonical name. No normalisation applied — caller must lowercase/trim.
 *  Without a type filter, non-deterministic if multiple entities share a canonical name. */
export function findEntityByCanonical(
  db: Database.Database,
  canonicalName: string,
): Entity | null {
  const row = db
    .prepare(`SELECT * FROM entities WHERE canonical_name = ?`)
    .get(canonicalName) as
    | (Omit<Entity, "metadata"> & { metadata: string | null })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}

/** Create an entity. Sets canonical_name = lower(trim(name)).
 *  Throws on duplicate (canonical_name, type) — use findOrCreateEntity for upsert. */
export function createEntity(
  db: Database.Database,
  entity: NewEntity,
): Entity {
  const id = randomUUID();
  const now = new Date().toISOString();
  const canonical = entity.name.toLowerCase().trim();
  const metadata = entity.metadata ? JSON.stringify(entity.metadata) : null;

  db.prepare(
    `INSERT INTO entities
       (id, type, name, canonical_name, metadata, created_at, access_count, last_accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
  ).run(id, entity.type, entity.name, canonical, metadata, now);

  return {
    id,
    type: entity.type,
    name: entity.name,
    canonical_name: canonical,
    metadata: entity.metadata ?? null,
    created_at: now,
    access_count: 0,
    last_accessed_at: null,
  };
}

/** Find or create an entity. Uses UNIQUE(canonical_name, type) constraint for safety. */
export function findOrCreateEntity(
  db: Database.Database,
  entity: NewEntity,
): { entity: Entity; created: boolean } {
  return db.transaction(() => {
    const existing = findEntity(db, entity.name, entity.type);
    if (existing) return { entity: existing, created: false };

    const created = createEntity(db, entity);
    return { entity: created, created: true };
  })();
}

// ---------------------------------------------------------------------------
// Fact–Entity links
// ---------------------------------------------------------------------------

/** Link a fact to an entity. INSERT OR IGNORE (composite PK handles dedup). */
export function linkFactEntity(
  db: Database.Database,
  factId: string,
  entityId: string,
  relationship: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO fact_entities (fact_id, entity_id, relationship)
     VALUES (?, ?, ?)`,
  ).run(factId, entityId, relationship);
}

// ---------------------------------------------------------------------------
// Entity edges
// ---------------------------------------------------------------------------

/**
 * Approach rate for entity edge strengthening.
 * Inspired by LTP saturation: early co-occurrences cause large jumps,
 * later ones diminish as the edge approaches 1.0.
 *
 * Formula: new_strength = old_strength + (1 - old_strength) * alpha
 * With alpha=0.3: step 1 → 0.30, 2 → 0.51, 3 → 0.66, 5 → 0.83, 10 → 0.97
 *
 * Monotonically increasing by construction — no practical precision concern at expected iteration counts.
 * Phase 3: the inference pipeline can adjust alpha based on observed
 * correction patterns (parametric feedback).
 */
export const EDGE_POTENTIATION_ALPHA = 0.3;

/** Create or strengthen an entity-to-entity edge using saturating potentiation.
 *  Caller must ensure both entity IDs exist (no FK enforcement). */
export function upsertEntityEdge(
  db: Database.Database,
  fromEntity: string,
  toEntity: string,
  relationship: string,
): void {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO entity_edges
       (from_entity, to_entity, relationship, strength, metadata, created_at, last_accessed_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT (from_entity, to_entity, relationship)
     DO UPDATE SET
       strength = strength + (1.0 - strength) * ?,
       last_accessed_at = ?`,
  ).run(
    fromEntity, toEntity, relationship,
    EDGE_POTENTIATION_ALPHA, now, now,
    EDGE_POTENTIATION_ALPHA, now,
  );
}

/** Get all edges from or to an entity. */
export function getEntityEdges(
  db: Database.Database,
  entityId: string,
): EntityEdge[] {
  const rows = db
    .prepare(
      `SELECT * FROM entity_edges WHERE from_entity = ? OR to_entity = ?`,
    )
    .all(entityId, entityId) as Array<
    Omit<EntityEdge, "metadata"> & { metadata: string | null }
  >;

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Access tracking
// ---------------------------------------------------------------------------

/** Update access tracking on an entity. */
export function updateEntityAccess(
  db: Database.Database,
  entityId: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE entities SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
  ).run(now, entityId);
}
