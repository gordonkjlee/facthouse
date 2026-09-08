import { describe, it, expect } from "vitest";
import {
  offerInitBackfill,
  parseHistoricExtract,
  shouldOfferInitBackfill,
  stdinCanAskHistoric,
} from "../../src/cli/init-backfill.js";
import { INIT_PROMPTS, INIT_SYNTHETIC } from "../../src/cli/init-knobs.js";
import { HISTORIC_CONFIRM_LINES } from "../../src/intelligence/steps.js";
import type { InitIo } from "../../src/cli/init-wizard.js";

function fakeIo(answers: string[]): InitIo & { prompts: string[]; writes: string[] } {
  let i = 0;
  const prompts: string[] = [];
  const writes: string[] = [];
  return {
    isTTY: true,
    prompts,
    writes,
    async question(prompt: string, _opts?: { signal?: AbortSignal }) {
      prompts.push(prompt);
      if (i >= answers.length) throw new Error(`unexpected question: ${prompt}`);
      return answers[i++];
    },
    write(text: string) {
      writes.push(text);
    },
  };
}

const defaultSelection = async (
  _dir: string,
  choice: { kind: string; n?: number; days?: number },
) => ({
  chosenCount: choice.kind === "limit" ? (choice.n ?? 0) : 3,
  truncatedChars: 120,
});

const copySource = [
  { kind: "claude-code" as const, home: INIT_SYNTHETIC.claudeHome, cwd: INIT_SYNTHETIC.cwd },
];

describe("shouldOfferInitBackfill", () => {
  it("is only TTY copy that just wrote config", () => {
    expect(
      shouldOfferInitBackfill({
        ttyWalk: true,
        wroteConfig: true,
        sources: copySource,
      }),
    ).toBe(true);
    expect(
      shouldOfferInitBackfill({
        ttyWalk: false,
        wroteConfig: true,
        sources: copySource,
      }),
    ).toBe(false);
    expect(
      shouldOfferInitBackfill({
        ttyWalk: true,
        wroteConfig: false,
        sources: copySource,
      }),
    ).toBe(false);
    expect(
      shouldOfferInitBackfill({
        ttyWalk: true,
        wroteConfig: true,
        sources: [],
      }),
    ).toBe(false);
  });
});

describe("stdinCanAskHistoric", () => {
  it("is the TTY wizard, or --web after the page if stdin is a TTY", () => {
    expect(
      stdinCanAskHistoric({
        usedTtyWizard: true,
        web: false,
        stdinIsTTY: true,
      }),
    ).toBe(true);
    expect(
      stdinCanAskHistoric({
        usedTtyWizard: false,
        web: true,
        stdinIsTTY: true,
      }),
    ).toBe(true);
    expect(
      stdinCanAskHistoric({
        usedTtyWizard: false,
        web: true,
        stdinIsTTY: false,
      }),
    ).toBe(false);
    expect(
      stdinCanAskHistoric({
        usedTtyWizard: false,
        web: false,
        stdinIsTTY: true,
      }),
    ).toBe(false);
  });
});

describe("parseHistoricExtract", () => {
  it("Enter and all mean every line", () => {
    expect(parseHistoricExtract("")).toEqual({ kind: "all" });
    expect(parseHistoricExtract("all")).toEqual({ kind: "all" });
  });

  it("N skips", () => {
    expect(parseHistoricExtract("n")).toEqual({ kind: "skip" });
    expect(parseHistoricExtract("no")).toEqual({ kind: "skip" });
  });

  it("a number is oldest n lines", () => {
    expect(parseHistoricExtract("100")).toEqual({ kind: "limit", n: 100 });
  });

  it("Nd is last n days", () => {
    expect(parseHistoricExtract("7d")).toEqual({ kind: "days", days: 7 });
    expect(parseHistoricExtract("30D")).toEqual({ kind: "days", days: 30 });
  });

  it("rejects zero and junk", () => {
    expect(parseHistoricExtract("0")).toEqual({ kind: "retry" });
    expect(parseHistoricExtract("0d")).toEqual({ kind: "retry" });
    expect(parseHistoricExtract("maybe")).toEqual({ kind: "retry" });
  });
});

describe("offerInitBackfill", () => {
  it("Enter copies then Enter extracts all", async () => {
    const io = fakeIo(["", ""]);
    const pulled: string[] = [];
    const consolidated: Array<{ dir: string; limit: number | null; since?: Date }> =
      [];
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async (dir) => {
        pulled.push(dir);
        return { events_inserted: 3 };
      },
      unextracted: async () => 3,
      consolidate: async (dir, opts) => {
        consolidated.push({ dir, limit: opts.extractLimit, since: opts.extractSince });
        return { factsIntegrated: 1, eventsRemaining: 0 };
      },
    });
    expect(io.prompts).toEqual([
      INIT_PROMPTS.historicCopy,
      INIT_PROMPTS.historicExtract(3),
    ]);
    expect(pulled).toEqual(["/tmp/store"]);
    expect(consolidated).toEqual([{ dir: "/tmp/store", limit: null }]);
    expect(io.writes).toContain(INIT_PROMPTS.copyingNow);
    expect(io.writes).toContain(INIT_PROMPTS.copiedLines(3));
    expect(io.writes).toContain(INIT_PROMPTS.extractingNow(3));
    expect(io.writes.indexOf(INIT_PROMPTS.copyingNow)).toBeLessThan(
      io.writes.indexOf(INIT_PROMPTS.copiedLines(3)),
    );
  });

  it("N on copy does not copy", async () => {
    const io = fakeIo(["n"]);
    let pulled = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async () => {
        pulled = true;
        return { events_inserted: 1 };
      },
      unextracted: async () => 1,
      consolidate: async () => {
        throw new Error("must not consolidate");
      },
    });
    expect(pulled).toBe(false);
    expect(io.prompts).toEqual([INIT_PROMPTS.historicCopy]);
  });

  it("N on extract copies but does not extract", async () => {
    const io = fakeIo(["", "n"]);
    let consolidated = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async () => ({ events_inserted: 9 }),
      unextracted: async () => 9,
      consolidate: async () => {
        consolidated = true;
        return { factsIntegrated: 0, eventsRemaining: 9 };
      },
    });
    expect(io.writes).toContain(INIT_PROMPTS.copyingNow);
    expect(io.writes).toContain(INIT_PROMPTS.copiedLines(9));
    expect(io.writes).not.toContain(INIT_PROMPTS.extractingNow(9));
    expect(consolidated).toBe(false);
    expect(io.prompts).toEqual([
      INIT_PROMPTS.historicCopy,
      INIT_PROMPTS.historicExtract(9),
    ]);
  });

  it("a number extracts that many oldest lines", async () => {
    const io = fakeIo(["", "100"]);
    let limit: number | null | undefined;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async () => ({ events_inserted: 200 }),
      unextracted: async () => 200,
      consolidate: async (_dir, opts) => {
        limit = opts.extractLimit;
        return { factsIntegrated: 2, eventsRemaining: 100 };
      },
    });
    expect(limit).toBe(100);
  });

  it("7d passes a since window and lifts the cap", async () => {
    const io = fakeIo(["", "7d"]);
    let since: Date | undefined;
    let limit: number | null | undefined;
    const before = Date.now();
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async () => ({ events_inserted: 200 }),
      unextracted: async () => 200,
      consolidate: async (_dir, opts) => {
        since = opts.extractSince;
        limit = opts.extractLimit;
        return { factsIntegrated: 2, eventsRemaining: 0 };
      },
    });
    const after = Date.now();
    expect(limit).toBeNull();
    expect(since).toBeInstanceOf(Date);
    const age = after - since!.getTime();
    expect(age).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
    expect(since!.getTime()).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000 - 1000);
  });

  it("skips extract when copy inserted nothing", async () => {
    const io = fakeIo([""]);
    let consolidated = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async () => ({ events_inserted: 0 }),
      unextracted: async () => 0,
      consolidate: async () => {
        consolidated = true;
      },
    });
    expect(io.writes).toContain(INIT_PROMPTS.copiedLines(0));
    expect(io.prompts).toEqual([INIT_PROMPTS.historicCopy]);
    expect(consolidated).toBe(false);
  });

  it("skips extract on the heuristic", async () => {
    const io = fakeIo([""]);
    let consolidated = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: true,
      selection: defaultSelection,
      copy: async () => ({ events_inserted: 9 }),
      unextracted: async () => 9,
      consolidate: async () => {
        consolidated = true;
      },
    });
    expect(io.writes).toContain(INIT_PROMPTS.extractSkippedHeuristic);
    expect(io.prompts).toEqual([INIT_PROMPTS.historicCopy]);
    expect(consolidated).toBe(false);
  });

  it("asks to type all again when the selection is 500 or more", async () => {
    const io = fakeIo(["", "", "all"]);
    let ran = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: async () => ({
        chosenCount: HISTORIC_CONFIRM_LINES,
        truncatedChars: 800_000,
      }),
      copy: async () => ({ events_inserted: HISTORIC_CONFIRM_LINES }),
      unextracted: async () => HISTORIC_CONFIRM_LINES,
      consolidate: async () => {
        ran = true;
        return { factsIntegrated: 1, eventsRemaining: 0 };
      },
    });
    expect(io.prompts[2]).toMatch(/Type all again/);
    expect(io.prompts[2]).toMatch(/sent to extract/);
    expect(ran).toBe(true);
  });

  it("empty Enter on confirm does not start the job", async () => {
    const io = fakeIo(["", "", "", "all"]);
    let ran = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: async () => ({
        chosenCount: HISTORIC_CONFIRM_LINES,
        truncatedChars: 800_000,
      }),
      copy: async () => ({ events_inserted: HISTORIC_CONFIRM_LINES }),
      unextracted: async () => HISTORIC_CONFIRM_LINES,
      consolidate: async () => {
        ran = true;
        return { factsIntegrated: 1, eventsRemaining: 0 };
      },
    });
    expect(io.prompts.filter((p) => /Type all again/.test(p))).toHaveLength(2);
    expect(ran).toBe(true);
  });

  it("switching from all to 7d then typing 7d runs 7d", async () => {
    const io = fakeIo(["", "all", "7d", "7d"]);
    let since: Date | undefined;
    let limit: number | null | undefined;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: async () => ({
        chosenCount: HISTORIC_CONFIRM_LINES,
        truncatedChars: 800_000,
      }),
      copy: async () => ({ events_inserted: HISTORIC_CONFIRM_LINES }),
      unextracted: async () => HISTORIC_CONFIRM_LINES,
      consolidate: async (_dir, opts) => {
        since = opts.extractSince;
        limit = opts.extractLimit;
        return { factsIntegrated: 1, eventsRemaining: 0 };
      },
    });
    expect(limit).toBeNull();
    expect(since).toBeInstanceOf(Date);
  });

  it("switching from 7d to all then typing all runs all", async () => {
    const io = fakeIo(["", "7d", "all", "all"]);
    let since: Date | undefined;
    let limit: number | null | undefined;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: async () => ({
        chosenCount: HISTORIC_CONFIRM_LINES,
        truncatedChars: 800_000,
      }),
      copy: async () => ({ events_inserted: HISTORIC_CONFIRM_LINES }),
      unextracted: async () => HISTORIC_CONFIRM_LINES,
      consolidate: async (_dir, opts) => {
        since = opts.extractSince;
        limit = opts.extractLimit;
        return { factsIntegrated: 1, eventsRemaining: 0 };
      },
    });
    expect(limit).toBeNull();
    expect(since).toBeUndefined();
  });

  it("writes skipReason and not a fake integrated 0", async () => {
    const io = fakeIo(["", "all"]);
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async () => ({ events_inserted: 60 }),
      unextracted: async () => 60,
      consolidate: async () => ({
        factsIntegrated: 0,
        eventsRemaining: 60,
        skipped: true,
        skipReason: "Spend envelope exhausted.",
      }),
    });
    expect(io.writes).toContain("Spend envelope exhausted.");
    expect(io.writes.some((w) => /Integrated 0/.test(w))).toBe(false);
  });

  it("held extract degrade does not print integrated as success", async () => {
    const io = fakeIo(["", "all"]);
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async () => ({ events_inserted: 9 }),
      unextracted: async () => 9,
      consolidate: async () => ({
        factsIntegrated: 0,
        eventsRemaining: 9,
        extractionDegraded: true,
        prefixCommitted: false,
      }),
    });
    expect(io.writes).toContain(INIT_PROMPTS.extractDegradedHeld);
    expect(io.writes.some((w) => w.startsWith("Integrated "))).toBe(false);
  });

  it("reports what integrate did and what remains, on the prompt channel", async () => {
    const io = fakeIo(["", "all"]);
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      selection: defaultSelection,
      copy: async () => ({ events_inserted: 60 }),
      unextracted: async () => 60,
      consolidate: async () => ({ factsIntegrated: 4, eventsRemaining: 10 }),
    });
    expect(io.writes).toContain(INIT_PROMPTS.integrated(4, 10));
    expect(io.writes.at(-1)).toMatch(/10 line\(s\) remain/);
  });
});
