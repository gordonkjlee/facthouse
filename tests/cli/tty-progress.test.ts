import { describe, it, expect, afterEach, vi } from "vitest";
import { createTtyProgress } from "../../src/cli/tty-progress.js";

describe("createTtyProgress embed phase", () => {
  const writes: string[] = [];
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
    writes.length = 0;
  });

  function capture() {
    writes.length = 0;
    spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  }

  it("json writes nothing for embed start, progress, or end", () => {
    capture();
    const p = createTtyProgress({ json: true });
    p.onEmbedStart();
    p.onEmbedProgress(0, 10);
    p.onEmbedProgress(5, 10, { durationMs: 1000, factCount: 5 });
    p.onEmbedEnd();
    p.stop();
    expect(writes.join("")).not.toMatch(/Checking|Embedding|fact\(s\)/);
  });

  it("embed progress says facts, not lines", () => {
    const origTty = process.stdout.isTTY;
    process.stdout.isTTY = false;
    capture();
    try {
      const p = createTtyProgress();
      p.onEmbedStart();
      p.onEmbedProgress(0, 3);
      p.onEmbedProgress(1, 3, { durationMs: 1000, factCount: 1 });
      p.onEmbedEnd();
      const out = writes.join("");
      expect(out).toContain("Checking embeddings…");
      expect(out).toContain("0 of 3 fact(s)…");
      expect(out).toContain("1 of 3 fact(s)…");
      expect(out).not.toMatch(/line\(s\)/);
    } finally {
      process.stdout.isTTY = origTty;
    }
  });
});
