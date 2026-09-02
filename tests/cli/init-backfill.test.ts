import { describe, it, expect } from "vitest";
import {
  offerInitBackfill,
  shouldOfferInitBackfill,
} from "../../src/cli/init-backfill.js";
import { INIT_PROMPTS, INIT_SYNTHETIC } from "../../src/cli/init-knobs.js";
import type { InitIo } from "../../src/cli/init-wizard.js";

function fakeIo(answers: string[]): InitIo & { prompts: string[]; writes: string[] } {
  let i = 0;
  const prompts: string[] = [];
  const writes: string[] = [];
  return {
    isTTY: true,
    prompts,
    writes,
    async question(prompt: string) {
      prompts.push(prompt);
      if (i >= answers.length) throw new Error(`unexpected question: ${prompt}`);
      return answers[i++];
    },
    write(text: string) {
      writes.push(text);
    },
  };
}

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

describe("offerInitBackfill", () => {
  it("Enter copies, then asks extract when events are unextracted", async () => {
    const io = fakeIo(["", ""]);
    const pulled: string[] = [];
    const consolidated: string[] = [];
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      copy: async (dir) => {
        pulled.push(dir);
        return { events_inserted: 3 };
      },
      unextracted: async () => 3,
      consolidate: async (dir) => {
        consolidated.push(dir);
      },
    });
    expect(io.prompts[0]).toBe(INIT_PROMPTS.copyNow);
    expect(io.prompts[1]).toBe(INIT_PROMPTS.extractNow);
    expect(pulled).toEqual(["/tmp/store"]);
    expect(consolidated).toEqual(["/tmp/store"]);
    expect(io.writes).toContain(INIT_PROMPTS.copiedEvents(3));
  });

  it("N on copy does not copy", async () => {
    const io = fakeIo(["n"]);
    let pulled = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
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
    expect(io.prompts).toEqual([INIT_PROMPTS.copyNow]);
  });

  it("skips extract when copy inserted nothing", async () => {
    const io = fakeIo([""]);
    let consolidated = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      copy: async () => ({ events_inserted: 0 }),
      unextracted: async () => 0,
      consolidate: async () => {
        consolidated = true;
      },
    });
    expect(io.writes).toContain(INIT_PROMPTS.copiedEvents(0));
    expect(io.prompts).toEqual([INIT_PROMPTS.copyNow]);
    expect(consolidated).toBe(false);
  });

  it("skips extract on the heuristic", async () => {
    const io = fakeIo([""]);
    let consolidated = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: true,
      copy: async () => ({ events_inserted: 9 }),
      unextracted: async () => 9,
      consolidate: async () => {
        consolidated = true;
      },
    });
    expect(io.writes).toContain(INIT_PROMPTS.extractSkippedHeuristic);
    expect(io.prompts).toEqual([INIT_PROMPTS.copyNow]);
    expect(consolidated).toBe(false);
  });

  it("N on extract does not consolidate", async () => {
    const io = fakeIo(["y", "n"]);
    let consolidated = false;
    await offerInitBackfill(io, "/tmp/store", {
      providerIsHeuristic: false,
      copy: async () => ({ events_inserted: 2 }),
      unextracted: async () => 2,
      consolidate: async () => {
        consolidated = true;
      },
    });
    expect(consolidated).toBe(false);
  });
});
