/**
 * Graph view-model for `openmemory inspect`.
 *
 * One definition for which nodes are on the canvas. The HTML snapshot uses the
 * same rules (kept in the page script; tests assert this module).
 */

export const SUBJECT_OF = "subject_of";
export const DEFAULT_TABLE_LIMIT = 10;
export const DEFAULT_GRAPH_CAP = 50;
export const INSPECT_CONTENT_CAP = 240;
export const D_PER_ENTITY = 12;
export const D_CAP = D_PER_ENTITY * 3;

export interface InspectNode {
  id: string;
  name: string;
  type: string;
  canonical_name: string;
  degree: number;
  about: number;
  mentions: number;
  dCount?: number;
}

export interface InspectEdge {
  from: string;
  to: string;
  relationship: string;
  strength: number;
}

export interface InspectLink {
  fact_id: string;
  entity_id: string;
  relationship: string;
}

export function relatedness(
  edges: InspectEdge[],
  sharedCount: (a: string, b: string) => number,
  centerId: string,
  otherId: string,
): number {
  let score = 0;
  for (const e of edges) {
    if (
      (e.from === centerId && e.to === otherId) ||
      (e.to === centerId && e.from === otherId)
    ) {
      score = Math.max(score, 10 * e.strength);
    }
  }
  score += sharedCount(centerId, otherId);
  return score;
}

export function egoIds(
  nodes: InspectNode[],
  edges: InspectEdge[],
  sharedCount: (a: string, b: string) => number,
  centerId: string,
  cap: number,
  typeFilter: string,
): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const scores = new Map<string, number>();
  for (const e of edges) {
    if (e.from === centerId) {
      scores.set(e.to, (scores.get(e.to) || 0) + 10 * e.strength);
    }
    if (e.to === centerId) {
      scores.set(e.from, (scores.get(e.from) || 0) + 10 * e.strength);
    }
  }
  for (const n of nodes) {
    if (n.id === centerId) continue;
    const shared = sharedCount(centerId, n.id);
    if (shared) scores.set(n.id, (scores.get(n.id) || 0) + shared);
  }
  const direct = [...scores.keys()];
  for (const mid of direct) {
    const via = scores.get(mid) || 0;
    for (const e of edges) {
      let hop: string | null = null;
      if (e.from === mid && e.to !== centerId) hop = e.to;
      else if (e.to === mid && e.from !== centerId) hop = e.from;
      if (!hop) continue;
      scores.set(hop, Math.max(scores.get(hop) || 0, via * 0.25 + 3 * e.strength));
    }
  }
  const ranked = [...scores.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        relatedness(edges, sharedCount, centerId, b[0]) -
          relatedness(edges, sharedCount, centerId, a[0]),
    )
    .map(([id]) => byId.get(id))
    .filter((n): n is InspectNode => Boolean(n))
    .filter((n) => !typeFilter || n.type === typeFilter || n.id === centerId);
  const ids = new Set<string>([centerId]);
  for (const n of ranked) {
    if (ids.size >= cap) break;
    ids.add(n.id);
  }
  return ids;
}

export function visibleIds(
  nodes: InspectNode[],
  edges: InspectEdge[],
  sharedCount: (a: string, b: string) => number,
  cap: number,
  query: string,
  typeFilter: string,
  center: InspectNode | null,
  focused: boolean,
): { ids: Set<string>; focus: InspectNode | null } {
  const q = query.trim().toLowerCase();
  let focus = center;
  if (!focus && q) {
    focus =
      nodes.find(
        (n) => n.name.toLowerCase() === q || n.canonical_name === q,
      ) ||
      nodes.find(
        (n) =>
          n.name.toLowerCase().includes(q) || n.canonical_name.includes(q),
      ) ||
      null;
  }
  if (focused && focus) {
    return { ids: egoIds(nodes, edges, sharedCount, focus.id, cap, typeFilter), focus };
  }
  const ranked = [...nodes].sort(
    (a, b) => b.degree - a.degree || a.name.localeCompare(b.name),
  );
  const ids = new Set<string>();
  for (const n of ranked) {
    if (ids.size >= cap) break;
    if (typeFilter && n.type !== typeFilter) continue;
    ids.add(n.id);
  }
  if (focus) ids.add(focus.id);
  return { ids, focus };
}

export function truncateInspect(content: string, cap = INSPECT_CONTENT_CAP): string {
  const s = content.replace(/\s+/g, " ").trim();
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}…`;
}

export function lookupNamedNodes(nodes: InspectNode[], name: string): InspectNode[] {
  const q = name.trim().toLowerCase();
  if (!q) return [];
  return nodes.filter(
    (n) => n.name.toLowerCase() === q || n.canonical_name === q,
  );
}
