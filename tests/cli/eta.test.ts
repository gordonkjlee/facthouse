import { describe, it, expect } from "vitest";
import { ChunkEta, formatEta } from "../../src/cli/eta.js";

describe("ChunkEta", () => {
  it("hides ETA until three model chunks", () => {
    const eta = new ChunkEta();
    eta.noteModelChunk(1000, 50);
    eta.noteModelChunk(1000, 50);
    expect(eta.etaMs(100)).toBeNull();
    eta.noteModelChunk(1000, 50);
    expect(eta.etaMs(150)).toBe(3000);
  });

  it("uses only the last eight samples", () => {
    const eta = new ChunkEta();
    for (let i = 0; i < 8; i++) eta.noteModelChunk(10_000, 50);
    for (let i = 0; i < 8; i++) eta.noteModelChunk(1000, 50);
    expect(eta.etaMs(50)).toBe(1000);
  });

  it("formatEta is minutes or seconds", () => {
    expect(formatEta(1000)).toBe("1s");
    expect(formatEta(60_000)).toBe("1m");
  });
});
