/**
 * One-pass multi-pattern substring match for inspect Data samples.
 * Haystacks and patterns are both folded with toLowerCase, matching
 * String.includes on a lowercased haystack. Empty patterns are skipped
 * (includes("") is true of every string; inspect never wants that).
 */

type AcNode = {
  next: Map<string, number>;
  fail: number;
  out: number[];
};

export interface NeedleHits {
  /** Event indices in haystack order (newest first if the array is). */
  ids: number[];
  count: number;
}

function buildAho(patterns: string[]): AcNode[] {
  const nodes: AcNode[] = [{ next: new Map(), fail: 0, out: [] }];

  const add = (pat: string, id: number) => {
    let u = 0;
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i]!;
      let v = nodes[u]!.next.get(ch);
      if (v === undefined) {
        v = nodes.length;
        nodes[u]!.next.set(ch, v);
        nodes.push({ next: new Map(), fail: 0, out: [] });
      }
      u = v;
    }
    nodes[u]!.out.push(id);
  };

  for (let i = 0; i < patterns.length; i++) add(patterns[i]!, i);

  const q: number[] = [];
  for (const [, v] of nodes[0]!.next) {
    nodes[v]!.fail = 0;
    q.push(v);
  }
  let qi = 0;
  while (qi < q.length) {
    const u = q[qi++]!;
    for (const [ch, v] of nodes[u]!.next) {
      let f = nodes[u]!.fail;
      while (f > 0 && !nodes[f]!.next.has(ch)) f = nodes[f]!.fail;
      const to = nodes[f]!.next.get(ch);
      nodes[v]!.fail = to !== undefined && to !== v ? to : 0;
      const failOut = nodes[nodes[v]!.fail]!.out;
      if (failOut.length) {
        nodes[v]!.out = nodes[v]!.out.concat(failOut);
      }
      q.push(v);
    }
  }
  return nodes;
}

function matchOne(nodes: AcNode[], text: string): number[] {
  const seen = new Set<number>();
  let u = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    while (u > 0 && !nodes[u]!.next.has(ch)) u = nodes[u]!.fail;
    const n = nodes[u]!.next.get(ch);
    u = n !== undefined ? n : 0;
    const out = nodes[u]!.out;
    for (let j = 0; j < out.length; j++) seen.add(out[j]!);
  }
  return [...seen];
}

/**
 * For each pattern, haystack indices that contain it as a substring.
 * `limitIds` caps stored indices per pattern; `count` is still every hit.
 */
export function substringHits(
  patterns: string[],
  haystacks: readonly string[],
  limitIds: number,
  onHaystack?: (done: number, total: number) => void,
): NeedleHits[] {
  const hits: NeedleHits[] = patterns.map(() => ({ ids: [], count: 0 }));
  if (!patterns.length || !haystacks.length) return hits;
  const folded = patterns.map((p) => p.toLowerCase());
  const acPats: string[] = [];
  const acToRow: number[] = [];
  for (let i = 0; i < folded.length; i++) {
    if (!folded[i]!.length) continue;
    acToRow.push(i);
    acPats.push(folded[i]!);
  }
  if (!acPats.length) return hits;
  const nodes = buildAho(acPats);
  const total = haystacks.length;
  const step = Math.max(1, Math.floor(total / 20));
  for (let i = 0; i < total; i++) {
    const found = matchOne(nodes, haystacks[i]!.toLowerCase());
    for (let k = 0; k < found.length; k++) {
      const p = acToRow[found[k]!]!;
      const row = hits[p]!;
      row.count++;
      if (row.ids.length < limitIds) row.ids.push(i);
    }
    if (onHaystack && (i === total - 1 || i % step === 0)) {
      onHaystack(i + 1, total);
    }
  }
  return hits;
}
