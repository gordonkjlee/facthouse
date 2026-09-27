import { describe, it, expect } from "vitest";
import { substringHits } from "../../src/cli/inspect-match.js";

describe("substringHits", () => {
  it("matches String.includes on lowercased text, newest-first ids", () => {
    const patterns = ["alex", "acme", "stg_orders"];
    const haystacks = [
      "Alex prefers dark roast at Acme",
      "unrelated line",
      "stg_orders is a table and also mentions Alex",
    ];
    const hits = substringHits(patterns, haystacks, 12);
    const brute = patterns.map((p) => {
      const ids: number[] = [];
      let count = 0;
      haystacks.forEach((h, i) => {
        if (h.toLowerCase().includes(p)) {
          count++;
          if (ids.length < 12) ids.push(i);
        }
      });
      return { ids, count };
    });
    expect(hits).toEqual(brute);
  });

  it("counts every hit but caps stored indices", () => {
    const haystacks = ["aa aa", "aa", "bb", "aa again"];
    const hits = substringHits(["aa"], haystacks, 2);
    expect(hits[0]!.count).toBe(3);
    expect(hits[0]!.ids).toEqual([0, 1]);
  });

  it("emits overlapping needles in one haystack", () => {
    const hits = substringHits(["ann", "anna"], ["Hannah and Anna"], 12);
    expect(hits[0]!.count).toBe(1);
    expect(hits[1]!.count).toBe(1);
  });

  it("skips empty inputs", () => {
    expect(substringHits([], ["a"], 12)).toEqual([]);
    expect(substringHits(["ab"], [], 12)).toEqual([{ ids: [], count: 0 }]);
  });

  it("matches a suffix pattern when a longer pattern also hits", () => {
    const hits = substringHits(["ab", "b"], ["xb", "ab", "aa"], 12);
    expect(hits[0]).toEqual({ ids: [1], count: 1 });
    expect(hits[1]).toEqual({ ids: [0, 1], count: 2 });
  });

  it("counts an overlapping run once per event, like includes", () => {
    const hits = substringHits(["aaa"], ["aaaa", "x"], 12);
    expect("aaaa".includes("aaa")).toBe(true);
    expect(hits[0]).toEqual({ ids: [0], count: 1 });
  });

  it("agrees with includes on a mixed batch", () => {
    const patterns = ["ab", "b", "abc", "x", "aa"];
    const haystacks = ["", "ab", "bab", "abcabc", "xxxx", "nope", "AaB"];
    const hits = substringHits(patterns, haystacks, 12);
    for (let p = 0; p < patterns.length; p++) {
      const ids: number[] = [];
      let count = 0;
      haystacks.forEach((h, i) => {
        if (h.toLowerCase().includes(patterns[p]!)) {
          count++;
          ids.push(i);
        }
      });
      expect(hits[p]).toEqual({ ids, count });
    }
  });

  it("calls onHaystack with done/total", () => {
    const seen: Array<[number, number]> = [];
    substringHits(["ab"], ["ab", "cd", "abab"], 12, (d, t) => seen.push([d, t]));
    expect(seen.at(-1)).toEqual([3, 3]);
    expect(seen[0]![1]).toBe(3);
  });

  it("folds pattern case the same way as the haystack", () => {
    const hits = substringHits(["Alex"], ["Alex prefers dark roast"], 12);
    expect(hits[0]).toEqual({ ids: [0], count: 1 });
  });

  it("does not treat an empty needle as a hit in every haystack", () => {
    const hits = substringHits(["", "ab"], ["ab", "x"], 12);
    expect(hits[0]).toEqual({ ids: [], count: 0 });
    expect(hits[1]).toEqual({ ids: [0], count: 1 });
  });

  it("agrees with includes on a seeded random batch", () => {
    let s = 1;
    const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0);
    const alphabet = "abcxé";
    const str = (n: number) => {
      let out = "";
      for (let i = 0; i < n; i++) out += alphabet[rnd() % alphabet.length];
      return out;
    };
    const patterns: string[] = [];
    const haystacks: string[] = [];
    for (let i = 0; i < 40; i++) patterns.push(str(1 + (rnd() % 4)));
    for (let i = 0; i < 80; i++) haystacks.push(str(rnd() % 12));
    const hits = substringHits(patterns, haystacks, 12);
    for (let p = 0; p < patterns.length; p++) {
      const needle = patterns[p]!.toLowerCase();
      const ids: number[] = [];
      let count = 0;
      haystacks.forEach((h, i) => {
        if (needle.length && h.toLowerCase().includes(needle)) {
          count++;
          if (ids.length < 12) ids.push(i);
        }
      });
      expect(hits[p]).toEqual({ ids, count });
    }
  });
});
