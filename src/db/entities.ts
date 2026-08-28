/**
 * Data access for entities and the knowledge graph.
 */

import { randomUUID } from "node:crypto";
import { withTransaction } from "./connection.js";
import type { Db, SqlParam } from "./connection.js";
import type { Entity, EntityEdge, Fact } from "../types/data.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface NewEntity {
  type: string;
  name: string;
  metadata?: Record<string, unknown> | null;
  /** Mark this entity as the user of the store. At most one may be. */
  is_self?: boolean;
}

/**
 * The reserved `fact_entities.relationship` value meaning "this fact is *about*
 * that entity", as opposed to merely naming it.
 *
 * Every other relationship value is freeform — extraction invents whatever the
 * content calls for, because a corporate store's relationships are supplier and
 * escalation contact and no fixed list covers both. This one value is reserved,
 * because the distinction between subject and mention is structural rather than
 * vocabulary: without it, "Robin approved Alex's transfer" is indistinguishable
 * from a fact about Alex, and `subject = X` cannot be asked.
 */
export const SUBJECT_OF = "subject_of";

/**
 * Reserved `entity_edges.relationship`: two ids are one thing at read.
 * Not co-mention. Walked by `resolveEntityFamily` only. Do not potentiate.
 */
export const SAME_AS = "same_as";

/** Refuse to walk a same_as component larger than this (fail closed). */
export const SAME_AS_FAMILY_CAP = 32;

/**
 * Extra type spellings seen on reuse, stored on `entities.metadata`.
 * Telemetry only — `listEntityTypes` still reads the `type` column.
 */
export const TYPE_SPELLINGS_KEY = "type_spellings";

/** Stored lookup key. Every row must satisfy canonical_name === this. */
export function storedCanonicalName(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Comparison fold for name/type punctuation. Not stored.
 * Hyphen, underscore, and whitespace become a space; other punctuation
 * becomes a space; runs collapse. Empty fold matches nothing.
 */
export function foldEntityToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\-_]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct entity types, most used first — extract names these so it reuses them. */
export async function listEntityTypes(db: Db): Promise<string[]> {
  const rows = (await db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM entities
       WHERE type IS NOT NULL AND type != ''
       GROUP BY type
       ORDER BY n DESC, type ASC`,
    )
    .all()) as Array<{ type: string }>;
  return rows.map((r) => r.type);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Look up an entity by its id. Returns null if not found. */
export async function getEntityById(
  db: Db,
  id: string,
): Promise<Entity | null> {
  const row = (await db
    .prepare(`SELECT * FROM entities WHERE id = ?`)
    .get(id)) as
    | (Omit<Entity, "metadata"> & { metadata: string | null })
    | undefined;
  if (!row) return null;
  return parseEntityRow(row);
}

function parseEntityRow(
  row: Omit<Entity, "metadata"> & { metadata: string | null },
): Entity {
  return {
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}

/**
 * One matching row. Without a type, the oldest (`created_at`, then id).
 * Callers that need every type-variant, including a punctuation-folded
 * name, must use `resolveEntityFamily`.
 */
export async function findEntity(
  db: Db,
  name: string,
  type?: string,
): Promise<Entity | null> {
  const rows = await findEntitiesByName(db, name, type);
  return rows[0] ?? null;
}

/**
 * Every entity whose canonical name matches. Type is an optional filter,
 * not the identity key. Ordered oldest-first so callers have a stable list.
 */
export async function findEntitiesByName(
  db: Db,
  name: string,
  type?: string,
): Promise<Entity[]> {
  const canonical = storedCanonicalName(name);
  let sql = `SELECT * FROM entities WHERE canonical_name = ?`;
  const params: SqlParam[] = [canonical];
  if (type !== undefined) {
    sql += ` AND type = ?`;
    params.push(type);
  }
  sql += ` ORDER BY created_at ASC, id ASC`;
  const rows = (await db.prepare(sql).all(...params)) as Array<
    Omit<Entity, "metadata"> & { metadata: string | null }
  >;
  return rows.map(parseEntityRow);
}

/**
 * Type-split rows of one name, including a unique punctuation-folded
 * canonical when the exact name misses. Confirmed `same_as` edges expand
 * the family. Empty when a fold would bind two *unlinked* canonicals.
 *
 * The one family lookup — write, named read, and search RRF all use this.
 */
export async function resolveEntityFamily(
  db: Db,
  name: string,
): Promise<Entity[]> {
  const exact = await findEntitiesByName(db, name);
  let seeds = exact;
  if (seeds.length === 0) {
    const folded = foldEntityToken(name);
    if (!folded) return [];
    const rows = (await db
      .prepare(`SELECT * FROM entities ORDER BY created_at ASC, id ASC`)
      .all()) as Array<Omit<Entity, "metadata"> & { metadata: string | null }>;
    const matches = rows
      .map(parseEntityRow)
      .filter((e) => foldEntityToken(e.canonical_name) === folded);
    if (matches.length === 0) return [];
    const canonicals = new Set(matches.map((e) => e.canonical_name));
    if (canonicals.size > 1) {
      const fromFirst = await expandSameAsIds(db, [matches[0]!.id]);
      if (!matches.every((e) => fromFirst.has(e.id))) return [];
    }
    seeds = matches;
  }

  const ids = await expandSameAsIds(db, seeds.map((e) => e.id));
  if (ids.size > SAME_AS_FAMILY_CAP) return seeds;
  if (ids.size === seeds.length && seeds.every((e) => ids.has(e.id))) {
    return seeds;
  }
  return getEntitiesByIds(db, [...ids]);
}

async function expandSameAsIds(db: Db, seedIds: string[]): Promise<Set<string>> {
  const seen = new Set(seedIds);
  const queue = [...seedIds];
  while (queue.length > 0) {
    if (seen.size > SAME_AS_FAMILY_CAP) return seen;
    const id = queue.pop()!;
    const rows = (await db
      .prepare(
        `SELECT from_entity, to_entity FROM entity_edges
          WHERE relationship = ? AND (from_entity = ? OR to_entity = ?)`,
      )
      .all(SAME_AS, id, id)) as Array<{ from_entity: string; to_entity: string }>;
    for (const row of rows) {
      const other = row.from_entity === id ? row.to_entity : row.from_entity;
      if (seen.has(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return seen;
}

async function getEntitiesByIds(db: Db, ids: string[]): Promise<Entity[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await db
    .prepare(
      `SELECT * FROM entities WHERE id IN (${placeholders})
        ORDER BY created_at ASC, id ASC`,
    )
    .all(...(ids as SqlParam[]))) as Array<
    Omit<Entity, "metadata"> & { metadata: string | null }
  >;
  return rows.map(parseEntityRow);
}

/** Confirm two entity ids are one thing at read. Idempotent. Does not potentiate. */
export async function recordSameAs(
  db: Db,
  leftId: string,
  rightId: string,
): Promise<void> {
  if (leftId === rightId) return;
  const a = await getEntityById(db, leftId);
  const b = await getEntityById(db, rightId);
  if (!a || !b) {
    throw new Error("Unknown entity id for same_as.");
  }
  const [from, to] = leftId < rightId ? [leftId, rightId] : [rightId, leftId];
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO entity_edges
         (from_entity, to_entity, relationship, strength, metadata, created_at, last_accessed_at)
       VALUES (?, ?, ?, 1.0, NULL, ?, ?)`,
    )
    .run(from, to, SAME_AS, now, now);
}

/** Undo `recordSameAs`. Silent if the edge is absent. */
export async function deleteSameAs(
  db: Db,
  leftId: string,
  rightId: string,
): Promise<void> {
  const [from, to] = leftId < rightId ? [leftId, rightId] : [rightId, leftId];
  await db
    .prepare(
      `DELETE FROM entity_edges
        WHERE from_entity = ? AND to_entity = ? AND relationship = ?`,
    )
    .run(from, to, SAME_AS);
}

/**
 * If one fact linked two entities whose names fold together but were stored
 * as two canonicals, they are a fail-closed C pair that speech just unified.
 */
export async function recordSameAsForLinkedFoldPair(
  db: Db,
  entities: Entity[],
): Promise<void> {
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const left = entities[i]!;
      const right = entities[j]!;
      if (left.canonical_name === right.canonical_name) continue;
      const foldL = foldEntityToken(left.canonical_name);
      const foldR = foldEntityToken(right.canonical_name);
      if (!foldL || foldL !== foldR) continue;
      await recordSameAs(db, left.id, right.id);
    }
  }
}

/** Find an entity by exact canonical name. No normalisation applied — caller must lowercase/trim.
 *  Without a type filter, the oldest row (`created_at`, then id). */
export async function findEntityByCanonical(
  db: Db,
  canonicalName: string,
): Promise<Entity | null> {
  const row = (await db
    .prepare(
      `SELECT * FROM entities WHERE canonical_name = ? ORDER BY created_at ASC, id ASC`,
    )
    .get(canonicalName)) as
    | (Omit<Entity, "metadata"> & { metadata: string | null })
    | undefined;
  if (!row) return null;
  return parseEntityRow(row);
}

/** Create an entity. Sets canonical_name = lower(trim(name)).
 *  Throws on duplicate (canonical_name, type) — use findOrCreateEntity for upsert. */
export async function createEntity(
  db: Db,
  entity: NewEntity,
): Promise<Entity> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const canonical = storedCanonicalName(entity.name);
  const metadata = entity.metadata ? JSON.stringify(entity.metadata) : null;

  const isSelf: 0 | 1 = entity.is_self ? 1 : 0;

  await db.prepare(
    `INSERT INTO entities
       (id, type, name, canonical_name, metadata, created_at, access_count, last_accessed_at, is_self)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
  ).run(id, entity.type, entity.name, canonical, metadata, now, isSelf);

  return {
    id,
    type: entity.type,
    name: entity.name,
    canonical_name: canonical,
    metadata: entity.metadata ?? null,
    created_at: now,
    access_count: 0,
    last_accessed_at: null,
    is_self: isSelf,
  };
}

/** Find or create an entity. Uses UNIQUE(canonical_name, type) constraint for safety. */
export async function findOrCreateEntity(
  db: Db,
  entity: NewEntity,
): Promise<{ entity: Entity; created: boolean }> {
  return withTransaction(db, async () => {
    const existing = await findEntity(db, entity.name, entity.type);
    if (existing) return { entity: existing, created: false };

    const family = await resolveEntityFamily(db, entity.name);
    if (family.length > 0) {
      const exactType = family.filter((e) => e.type === entity.type);
      if (exactType.length === 1) {
        return { entity: exactType[0]!, created: false };
      }

      const typeFold = foldEntityToken(entity.type);
      if (typeFold) {
        const foldHits = family.filter(
          (e) => foldEntityToken(e.type) === typeFold,
        );
        if (foldHits.length === 1) {
          const hit = foldHits[0]!;
          if (entity.type !== hit.type) {
            return {
              entity: await recordTypeSpelling(db, hit, entity.type),
              created: false,
            };
          }
          return { entity: hit, created: false };
        }
      }

      const oldest = family[0]!;
      const created = await createEntity(db, {
        type: entity.type,
        name: oldest.name,
        metadata: entity.metadata,
      });
      return { entity: created, created: true };
    }

    const created = await createEntity(db, entity);
    return { entity: created, created: true };
  });
}

async function recordTypeSpelling(
  db: Db,
  entity: Entity,
  spelling: string,
): Promise<Entity> {
  if (spelling === entity.type) return entity;
  const meta: Record<string, unknown> = { ...(entity.metadata ?? {}) };
  const extra = extraTypeSpellings(meta);
  if (extra.includes(spelling)) return entity;
  extra.push(spelling);
  meta[TYPE_SPELLINGS_KEY] = extra;
  await db
    .prepare(`UPDATE entities SET metadata = ? WHERE id = ?`)
    .run(JSON.stringify(meta), entity.id);
  return { ...entity, metadata: meta };
}

function extraTypeSpellings(metadata: Record<string, unknown>): string[] {
  const raw = metadata[TYPE_SPELLINGS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

// ---------------------------------------------------------------------------
// Fact–Entity links
// ---------------------------------------------------------------------------

/** Link a fact to an entity. INSERT OR IGNORE (composite PK handles dedup). */
export async function linkFactEntity(
  db: Db,
  factId: string,
  entityId: string,
  relationship: string,
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO fact_entities (fact_id, entity_id, relationship)
     VALUES (?, ?, ?)`,
  ).run(factId, entityId, relationship);
}

/**
 * The entity representing the user of this store, or null if none exists.
 *
 * Nameless is the normal state, not a defect: the singleton is created before
 * anything is known, and the user's name arrives later as an ordinary fact.
 */
export async function getSelfEntity(db: Db): Promise<Entity | null> {
  const row = (await db
    .prepare(`SELECT * FROM entities WHERE is_self = 1`)
    .get()) as (Omit<Entity, "metadata"> & { metadata: string | null }) | undefined;
  if (!row) return null;
  return parseEntityRow(row);
}

/**
 * Get the self entity, creating it if this store has none. Idempotent.
 *
 * The placeholder name is a display fallback, not an identity claim — nothing
 * matches on it, and `findEntity` resolves by canonical name, so it cannot
 * collide with a real person called anything. When the user's name is learned
 * it attaches as a fact about this entity; the row does not need renaming for
 * the anchor to work, because the anchor is the id.
 */
export async function ensureSelfEntity(db: Db): Promise<Entity> {
  return (await getSelfEntity(db)) ?? (await createEntity(db, {
    type: "person",
    name: "the user",
    is_self: true,
  }));
}

/**
 * Facts whose *subject* is this entity — what is known about it, as opposed to
 * every fact that happens to name it.
 *
 * This is the query the whole self/subject apparatus exists to make possible.
 * `getFactsByEntity` answers "where is this mentioned", which is a superset and
 * a different question: a fact naming Robin as an approver is not a fact about
 * Robin.
 */
export async function getFactsBySubject(db: Db, entityId: string): Promise<Fact[]> {
  const rows = (await db
    .prepare(
      // Same currency filters as getFactsByEntity — active, latest, and still
      // within its validity window. Ordered by importance because that is what
      // ranked retrieval reads; a subject's facts are a list someone will
      // truncate, so the useful ones have to come first.
      `SELECT f.* FROM facts f
         JOIN fact_entities fe ON fe.fact_id = f.id
        WHERE fe.entity_id = ? AND fe.relationship = ?
          AND f.status = 'active' AND f.is_latest = 1
          AND (f.valid_until IS NULL OR f.valid_until > datetime('now'))
        ORDER BY f.importance DESC, f.created_at DESC`,
    )
    .all(entityId, SUBJECT_OF)) as Array<Omit<Fact, "is_latest"> & { is_latest: number }>;
  return rows.map((row) => ({ ...row, is_latest: row.is_latest === 1 }));
}

/**
 * Fetch the entities linked to each of several facts, in one query.
 *
 * For enriching a page of search results: a lookup per result would be an N+1
 * over the whole page, and search is the hottest read path there is.
 *
 * Facts with no linked entities are simply absent from the map — callers should
 * treat a miss as an empty list rather than expecting a key for every id.
 */
export async function getEntitiesForFacts(
  db: Db,
  factIds: string[],
): Promise<Map<string, Entity[]>> {
  const byFact = new Map<string, Entity[]>();
  if (factIds.length === 0) return byFact;

  const placeholders = factIds.map(() => "?").join(",");
  const rows = (await db
    .prepare(
      `SELECT fe.fact_id AS fact_id, e.*
         FROM fact_entities fe
         JOIN entities e ON e.id = fe.entity_id
        WHERE fe.fact_id IN (${placeholders})
        ORDER BY e.name`,
    )
    .all(...(factIds as SqlParam[]))) as Array<
    Omit<Entity, "metadata"> & { fact_id: string; metadata: string | null }
  >;

  for (const { fact_id, ...row } of rows) {
    const entity: Entity = {
      ...row,
      metadata: row.metadata
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : null,
    };
    const existing = byFact.get(fact_id);
    if (existing) existing.push(entity);
    else byFact.set(fact_id, [entity]);
  }

  return byFact;
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
 * A future inference pipeline could adjust alpha based on observed
 * correction patterns (parametric feedback).
 */
export const EDGE_POTENTIATION_ALPHA = 0.3;

/** Create or strengthen an entity-to-entity edge using saturating potentiation.
 *  Caller must ensure both entity IDs exist (no FK enforcement). */
export async function upsertEntityEdge(
  db: Db,
  fromEntity: string,
  toEntity: string,
  relationship: string,
): Promise<void> {
  const now = new Date().toISOString();

  await db.prepare(
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
export async function getEntityEdges(
  db: Db,
  entityId: string,
): Promise<EntityEdge[]> {
  const rows = (await db
    .prepare(
      `SELECT * FROM entity_edges WHERE from_entity = ? OR to_entity = ?`,
    )
    .all(entityId, entityId)) as Array<
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
export async function updateEntityAccess(
  db: Db,
  entityId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE entities SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
  ).run(now, entityId);
}
