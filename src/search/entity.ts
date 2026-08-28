/**
 * "Tell me about X" — one operation for a named subject.
 *
 * Exact entity match ranks facts that are *about* X above facts that merely
 * name it. A miss must not be empty when the store still holds knowledge
 * under that wording: that is the domain-gate failure on a second axis.
 * Search fills the gap as mentions (is_subject false), never as a guessed
 * subject.
 */

import type { Db } from "../db/connection.js";
import type { Entity, EntityEdge, EntityFact, SearchResponse } from "../types/data.js";
import type { InterlocutorConfig } from "../types/config.js";
import { resolveEntityFamily, getEntityEdges, SAME_AS } from "../db/entities.js";
import { getFactsByEntity } from "../db/facts.js";
import { hybridSearch } from "./index.js";

/** Strongest 1-hop neighbours shown by `get_context`. */
const CONTEXT_EDGE_CAP = 10;
/** Facts per neighbour in that hop. */
const CONTEXT_FACTS_PER_NEIGHBOUR = 5;

export interface NamedSubjectLookup {
  found: boolean;
  name: string;
  entity: Entity | null;
  /** Every row sharing this canonical name when the lookup unioned types. */
  entities: Entity[];
  facts: EntityFact[];
  relationships: EntityEdge[];
  /**
   * True when a type filter missed that pair but other types exist for the
   * name. The facts are the sibling union, not a keyword search.
   */
  type_missed: boolean;
}

export async function lookupNamedSubject(
  db: Db,
  name: string,
  type?: string,
): Promise<NamedSubjectLookup> {
  const siblings = await resolveEntityFamily(db, name);
  if (type !== undefined) {
    const hit = siblings.filter((e) => e.type === type);
    if (hit.length > 0) return packNamedSubject(db, name, hit, false);
    if (siblings.length > 0) return packNamedSubject(db, name, siblings, true);
    // Name does not exist at all — search-fill mentions; do not hard-empty.
  } else if (siblings.length > 0) {
    return packNamedSubject(db, name, siblings, false);
  }

  const search = await hybridSearch(db, name, { limit: 20 });
  const facts: EntityFact[] = search.results.map((r) => ({
    ...r.fact,
    is_subject: false,
  }));
  return {
    found: false,
    name,
    entity: null,
    entities: [],
    facts,
    relationships: [],
    type_missed: false,
  };
}

export interface TopicContext {
  search: SearchResponse;
  entity: Entity | null;
  entities: Entity[];
  connected: Array<{
    entity_name: string;
    relationship: string;
    facts: EntityFact[];
  }>;
}

/**
 * Search plus a 1-hop walk from every type-split node of the topic name.
 * First-match would hide edges attached to a sibling type.
 */
export async function getTopicContext(
  db: Db,
  topic: string,
  interlocutor?: InterlocutorConfig,
): Promise<TopicContext> {
  const search = await hybridSearch(db, topic, { interlocutor });
  const subject = await lookupNamedSubject(db, topic);
  const matched = subject.entities;
  const connected: TopicContext["connected"] = [];

  if (matched.length === 0) {
    return { search, entity: subject.entity, entities: matched, connected };
  }

  const matchedIds = new Set(matched.map((e) => e.id));
  const edgeLists = await Promise.all(
    matched.map((e) => getEntityEdges(db, e.id)),
  );
  const edges = edgeLists
    .flat()
    .filter((edge) => edge.relationship !== SAME_AS)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, CONTEXT_EDGE_CAP);

  const connectedIds = edges.map((edge) =>
    matchedIds.has(edge.from_entity) ? edge.to_entity : edge.from_entity,
  );
  const nameMap = new Map<string, string>();
  if (connectedIds.length > 0) {
    const placeholders = connectedIds.map(() => "?").join(",");
    const rows = (await db
      .prepare(`SELECT id, name FROM entities WHERE id IN (${placeholders})`)
      .all(...connectedIds)) as Array<{ id: string; name: string }>;
    for (const row of rows) nameMap.set(row.id, row.name);
  }

  for (const edge of edges) {
    const connectedEntityId = matchedIds.has(edge.from_entity)
      ? edge.to_entity
      : edge.from_entity;
    const facts = (await getFactsByEntity(db, connectedEntityId)).slice(
      0,
      CONTEXT_FACTS_PER_NEIGHBOUR,
    );
    if (facts.length > 0) {
      connected.push({
        entity_name: nameMap.get(connectedEntityId) ?? connectedEntityId,
        relationship: edge.relationship,
        facts,
      });
    }
  }

  return { search, entity: subject.entity, entities: matched, connected };
}

async function packNamedSubject(
  db: Db,
  name: string,
  entities: Entity[],
  typeMissed: boolean,
): Promise<NamedSubjectLookup> {
  const factsById = new Map<string, EntityFact>();
  const factCount = new Map<string, number>();
  const relationships: EntityEdge[] = [];
  const seenEdge = new Set<string>();

  for (const entity of entities) {
    const facts = await getFactsByEntity(db, entity.id);
    factCount.set(entity.id, facts.length);
    for (const fact of facts) {
      const prev = factsById.get(fact.id);
      if (!prev) factsById.set(fact.id, fact);
      else if (fact.is_subject && !prev.is_subject) factsById.set(fact.id, fact);
    }
    for (const edge of await getEntityEdges(db, entity.id)) {
      const key = `${edge.from_entity}\0${edge.to_entity}\0${edge.relationship}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      relationships.push(edge);
    }
  }

  const primary = pickPrimaryEntity(entities, factCount);
  const facts = [...factsById.values()];
  facts.sort((a, b) => {
    if (a.is_subject !== b.is_subject) return a.is_subject ? -1 : 1;
    return (b.importance ?? 0) - (a.importance ?? 0);
  });

  return {
    found: true,
    name,
    entity: primary,
    entities,
    facts,
    relationships,
    type_missed: typeMissed,
  };
}

function pickPrimaryEntity(
  entities: Entity[],
  factCount: Map<string, number>,
): Entity {
  return [...entities].sort((a, b) => {
    const dc = (factCount.get(b.id) ?? 0) - (factCount.get(a.id) ?? 0);
    if (dc !== 0) return dc;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0]!;
}
