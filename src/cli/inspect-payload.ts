/**
 * Read-only inspect samples and graph payload. Queries go through Db.
 */

import type { Db } from "../db/connection.js";
import { currencyClause } from "../db/facts.js";
import { SUBJECT_OF } from "../db/entities.js";
import { getUnconsolidatedFacts } from "../db/session-facts.js";
import { getStats, type KnowledgeStats } from "../db/stats.js";
import {
  D_CAP,
  D_PER_ENTITY,
  truncateInspect,
  type InspectEdge,
  type InspectLink,
  type InspectNode,
} from "./inspect-model.js";

const NEAR_USER = 8;
const NEAR_RADIUS = 3;

export interface InspectFactRow {
  id: string;
  content: string;
  domain: string;
  subdomain: string | null;
  confidence: number;
  importance: number;
  source_type: string;
  source_tool: string | null;
  created_at: string;
  valid_from: string | null;
  valid_until: string | null;
  speaker_role: string | null;
  speaker: string | null;
  source_id: string | null;
  status: string;
  superseded_by: string | null;
  is_latest: number;
}

export interface InspectInfoRow {
  id: string;
  content: string;
  domain_hint: string | null;
  confidence: number | null;
  importance: number | null;
  source_origin: string;
  source_quality: string | null;
  created_at: string;
  valid_from_hint: string | null;
  valid_until_hint: string | null;
  speaker_role: string | null;
  speaker: string | null;
  consolidation_id: string | null;
  session_id: string;
}

export interface InspectEventRow {
  id: string;
  sequence: number;
  conversation: string | null;
  role: string;
  event_type: string;
  created_at: string;
  occurred_at: string | null;
  tool_name: string | null;
  content: string;
  full: string | null;
}

export interface InspectSourceRow {
  id: string;
  session_fact_id: string | null;
}

export interface InspectIToDRow {
  session_fact_id: string;
  event_id: string;
  extraction_type: string;
}

export interface InspectGraphPayload {
  nodes: InspectNode[];
  edges: InspectEdge[];
  facts: InspectFactRow[];
  links: InspectLink[];
  info: InspectInfoRow[];
  events: InspectEventRow[];
  sources: InspectSourceRow[];
  iToD: InspectIToDRow[];
  dByEntity: Record<string, string[]>;
  eventCount: number;
  eventShown: number;
  dCap: number;
  selectedId: string | null;
  cap: number;
}

export interface InspectLayerRows {
  d: Array<{
    sequence: number;
    conversation: string;
    event_type: string;
    role: string;
    content: string;
  }>;
  i: Array<{ content: string; domain_hint: string | null; created_at: string }>;
  k: Array<{ content: string; domain: string; entities: string }>;
  entities: Array<{ type: string; name: string; id: string }>;
  graph: Array<{
    from: string;
    to: string;
    relationship: string;
    strength: number;
  }>;
  relationship_histogram: Array<{ relationship: string; count: number }>;
  entity_total: number;
  pending_i: number;
}

function isNoiseContent(c: string): boolean {
  return /<task-notification>|<command-name>|<local-command/.test(c || "");
}

function toolNameFromContent(raw: string): string | null {
  const m = (raw || "").match(/"name"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function clipText(c: string): { content: string; full: string | null } {
  const s = c || "";
  if (s.length <= 900) return { content: s, full: null };
  return {
    content: `${s.slice(0, 280)}…`,
    full: s.length > 8000 ? `${s.slice(0, 8000)}…` : s,
  };
}

export async function loadLayerRows(
  db: Db,
  limit: number,
): Promise<InspectLayerRows> {
  const currency = currencyClause();
  const d = (await db
    .prepare(
      `SELECT sequence,
              COALESCE(client_session_id, mcp_session_id, '') AS conversation,
              event_type, role, COALESCE(content, '') AS content
         FROM session_events
        ORDER BY sequence DESC
        LIMIT ?`,
    )
    .all(limit)) as InspectLayerRows["d"];

  const pending = await getUnconsolidatedFacts(db);
  const i = pending
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit)
    .map((p) => ({
      content: p.content,
      domain_hint: p.domain_hint,
      created_at: p.created_at,
    }));

  const kRows = (await db
    .prepare(
      `SELECT id, content, domain FROM facts
        WHERE ${currency.sql}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(limit)) as Array<{ id: string; content: string; domain: string }>;
  const kIds = kRows.map((r) => r.id);
  const namesByFact = new Map<string, string[]>();
  if (kIds.length) {
    const ph = kIds.map(() => "?").join(",");
    const linked = (await db
      .prepare(
        `SELECT fe.fact_id AS fact_id, e.name AS name
           FROM fact_entities fe
           JOIN entities e ON e.id = fe.entity_id
          WHERE fe.fact_id IN (${ph})
          ORDER BY e.name`,
      )
      .all(...kIds)) as Array<{ fact_id: string; name: string }>;
    for (const row of linked) {
      const list = namesByFact.get(row.fact_id) ?? [];
      list.push(row.name);
      namesByFact.set(row.fact_id, list);
    }
  }
  const k = kRows.map((r) => ({
    content: r.content,
    domain: r.domain,
    entities: (namesByFact.get(r.id) ?? []).join(", "),
  }));

  const entityTotal = (
    (await db.prepare(`SELECT COUNT(*) AS n FROM entities`).get()) as { n: number }
  ).n;
  const entitySql =
    entityTotal > limit
      ? `SELECT type, name, id FROM entities ORDER BY created_at DESC LIMIT ?`
      : `SELECT type, name, id FROM entities ORDER BY created_at DESC`;
  const entities = (
    entityTotal > limit
      ? await db.prepare(entitySql).all(limit)
      : await db.prepare(entitySql).all()
  ) as InspectLayerRows["entities"];

  const graph = (await db
    .prepare(
      `SELECT e1.name AS "from", e2.name AS "to",
              ee.relationship AS relationship, ee.strength AS strength
         FROM entity_edges ee
         JOIN entities e1 ON e1.id = ee.from_entity
         JOIN entities e2 ON e2.id = ee.to_entity
        ORDER BY ee.strength DESC
        LIMIT ?`,
    )
    .all(limit)) as InspectLayerRows["graph"];

  const relationship_histogram = (await db
    .prepare(
      `SELECT relationship, COUNT(*) AS count
         FROM fact_entities
        GROUP BY relationship
        ORDER BY count DESC`,
    )
    .all()) as InspectLayerRows["relationship_histogram"];

  return {
    d: d.map((row) => ({ ...row, content: truncateInspect(row.content) })),
    i: i.map((row) => ({ ...row, content: truncateInspect(row.content) })),
    k: k.map((row) => ({ ...row, content: truncateInspect(row.content) })),
    entities,
    graph,
    relationship_histogram,
    entity_total: entityTotal,
    pending_i: pending.length,
  };
}

export async function loadGraphPayload(
  db: Db,
  opts: { cap: number; entity?: string; all?: boolean },
): Promise<InspectGraphPayload> {
  const entityRows = (await db
    .prepare(`SELECT id, name, type, canonical_name FROM entities`)
    .all()) as Array<{
    id: string;
    name: string;
    type: string;
    canonical_name: string;
  }>;

  const edges = (await db
    .prepare(
      `SELECT from_entity AS "from", to_entity AS "to", relationship, strength
         FROM entity_edges`,
    )
    .all()) as InspectEdge[];

  const facts = (await db
    .prepare(
      `SELECT id, content, domain, subdomain, confidence, importance,
              source_type, source_tool, created_at, valid_from, valid_until,
              speaker_role, speaker, source_id, status, superseded_by, is_latest
         FROM facts
        WHERE status IN ('active', 'superseded')`,
    )
    .all()) as InspectFactRow[];

  const links = (await db
    .prepare(`SELECT fact_id, entity_id, relationship FROM fact_entities`)
    .all()) as InspectLink[];

  const info = (await db
    .prepare(
      `SELECT id, content, domain_hint,
              COALESCE(confidence, confidence_signal) AS confidence,
              COALESCE(importance, importance_signal) AS importance,
              source_origin, source_quality, created_at,
              valid_from_hint, valid_until_hint,
              speaker_role, speaker, consolidation_id, session_id
         FROM session_facts
        ORDER BY created_at DESC`,
    )
    .all()) as InspectInfoRow[];

  const eventsRaw = (await db
    .prepare(
      `SELECT id, sequence,
              COALESCE(client_session_id, mcp_session_id) AS conversation,
              role, event_type, content, created_at, occurred_at
         FROM session_events
        WHERE content IS NOT NULL AND TRIM(content) != ''
        ORDER BY sequence DESC`,
    )
    .all()) as Array<{
    id: string;
    sequence: number;
    conversation: string | null;
    role: string;
    event_type: string;
    content: string;
    created_at: string;
    occurred_at: string | null;
  }>;

  const sources = (
    (await db.prepare(`SELECT id, metadata FROM sources`).all()) as Array<{
      id: string;
      metadata: string | null;
    }>
  ).map((s) => {
    let session_fact_id: string | null = null;
    try {
      const m = s.metadata ? JSON.parse(s.metadata) : null;
      if (m && typeof m.session_fact_id === "string") {
        session_fact_id = m.session_fact_id;
      }
    } catch {
      /* ignore */
    }
    return { id: s.id, session_fact_id };
  });

  const iToD = (await db
    .prepare(
      `SELECT session_fact_id, event_id, extraction_type FROM session_fact_sources
        WHERE extraction_type != 'contextual'`,
    )
    .all()) as InspectIToDRow[];

  const eventCount = (
    (await db.prepare(`SELECT COUNT(*) AS n FROM session_events`).get()) as {
      n: number;
    }
  ).n;

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const factsByEntity = new Map<string, InspectLink[]>();
  for (const l of links) {
    const list = factsByEntity.get(l.entity_id) ?? [];
    list.push(l);
    factsByEntity.set(l.entity_id, list);
  }

  const nodes: InspectNode[] = entityRows.map((n) => {
    const fl = factsByEntity.get(n.id) ?? [];
    const about = fl.filter((x) => x.relationship === SUBJECT_OF).length;
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      canonical_name: n.canonical_name,
      degree: degree.get(n.id) ?? 0,
      about,
      mentions: fl.length - about,
    };
  });

  const eventByIdRaw = new Map(eventsRaw.map((e) => [e.id, e]));
  const lower = eventsRaw.map((ev) => (ev.content || "").toLowerCase());
  const byConvSeq = new Map<string, typeof eventsRaw>();
  for (const ev of eventsRaw) {
    const conv = ev.conversation || "";
    const list = byConvSeq.get(conv) ?? [];
    list.push(ev);
    byConvSeq.set(conv, list);
  }
  for (const list of byConvSeq.values()) {
    list.sort((a, b) => a.sequence - b.sequence);
  }

  function nearestUserId(conv: string, seq: number): string | null {
    const list = byConvSeq.get(conv || "") || [];
    let best: string | null = null;
    for (const ev of list) {
      if (ev.sequence > seq) break;
      if (seq - ev.sequence > NEAR_USER) continue;
      if (ev.role === "user" && !isNoiseContent(ev.content)) best = ev.id;
    }
    return best;
  }

  function addContext(idSet: Set<string>, eventId: string): void {
    const hit = eventByIdRaw.get(eventId);
    if (!hit) return;
    idSet.add(hit.id);
    const uid = nearestUserId(hit.conversation || "", hit.sequence);
    if (uid) idSet.add(uid);
    for (const ev of byConvSeq.get(hit.conversation || "") || []) {
      if (Math.abs(ev.sequence - hit.sequence) <= NEAR_RADIUS) idSet.add(ev.id);
    }
  }

  function pickD(hitIds: string[], extraSet: Set<string>): string[] {
    const users: string[] = [];
    const rest: string[] = [];
    const hitSet = new Set(hitIds);
    for (const id of extraSet) {
      if (hitSet.has(id)) continue;
      const ev = eventByIdRaw.get(id);
      if (ev && ev.role === "user" && !isNoiseContent(ev.content)) users.push(id);
      else rest.push(id);
    }
    const out = [...hitIds];
    for (const id of users) {
      if (out.length >= D_CAP) break;
      if (!out.includes(id)) out.push(id);
    }
    for (const id of rest) {
      if (out.length >= D_CAP) break;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  const dByEntity: Record<string, string[]> = {};
  for (const n of nodes) {
    const needle = (n.canonical_name || n.name || "").toLowerCase();
    if (needle.length < 2) {
      n.dCount = 0;
      dByEntity[n.id] = [];
      continue;
    }
    const ids: string[] = [];
    let matchCount = 0;
    for (let i = 0; i < eventsRaw.length; i++) {
      if (lower[i].includes(needle)) {
        matchCount++;
        if (ids.length < D_PER_ENTITY) ids.push(eventsRaw[i].id);
      }
    }
    n.dCount = matchCount;
    const extra = new Set(ids);
    for (const eid of ids) addContext(extra, eid);
    dByEntity[n.id] = pickD(ids, extra);
  }

  const used = new Set(Object.values(dByEntity).flat());
  for (const row of iToD) addContext(used, row.event_id);

  function toolNameFor(e: (typeof eventsRaw)[number]): string | null {
    const own = toolNameFromContent(e.content);
    if (own) return own;
    if (e.role !== "tool" && e.event_type !== "tool_result") return null;
    const list = byConvSeq.get(e.conversation || "") || [];
    const idx = list.findIndex((x) => x.id === e.id);
    for (let i = idx - 1; i >= 0 && i >= idx - 4; i--) {
      const name = toolNameFromContent(list[i].content);
      if (name) return name;
      if (list[i].role === "user") break;
    }
    return null;
  }

  const events: InspectEventRow[] = eventsRaw
    .filter((e) => used.has(e.id))
    .map((e) => {
      const clipped = clipText(e.content || "");
      return {
        id: e.id,
        sequence: e.sequence,
        conversation: e.conversation,
        role: e.role,
        event_type: e.event_type,
        created_at: e.created_at,
        occurred_at: e.occurred_at,
        tool_name: toolNameFor(e),
        content: clipped.content,
        full: clipped.full,
      };
    });

  let selectedId: string | null = null;
  if (opts.entity) {
    const q = opts.entity.trim().toLowerCase();
    const hits = nodes.filter(
      (n) => n.name.toLowerCase() === q || n.canonical_name === q,
    );
    selectedId = hits[0]?.id ?? null;
  }

  return {
    nodes,
    edges,
    facts,
    links,
    info,
    events,
    sources,
    iToD,
    dByEntity,
    eventCount,
    eventShown: events.length,
    dCap: D_CAP,
    selectedId,
    cap: opts.all ? Math.max(nodes.length, 1) : opts.cap,
  };
}

export async function loadHealth(db: Db): Promise<KnowledgeStats> {
  return getStats(db);
}
