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
import type { Entity, EntityEdge } from "../types/data.js";
import type { EntityFact } from "../types/data.js";
import { findEntity, getEntityEdges } from "../db/entities.js";
import { getFactsByEntity } from "../db/facts.js";
import { hybridSearch } from "./index.js";

export interface NamedSubjectLookup {
  found: boolean;
  name: string;
  entity: Entity | null;
  facts: EntityFact[];
  relationships: EntityEdge[];
}

export async function lookupNamedSubject(
  db: Db,
  name: string,
  type?: string,
): Promise<NamedSubjectLookup> {
  const entity = await findEntity(db, name, type);
  if (entity) {
    return {
      found: true,
      name,
      entity,
      facts: await getFactsByEntity(db, entity.id),
      relationships: await getEntityEdges(db, entity.id),
    };
  }

  // A type filter is disambiguation. Missing that pair is a real miss —
  // searching would ignore the type the caller needed.
  if (type !== undefined) {
    return {
      found: false,
      name,
      entity: null,
      facts: [],
      relationships: [],
    };
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
    facts,
    relationships: [],
  };
}
