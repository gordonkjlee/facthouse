import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
} from "../../src/types/config.js";
import {
  EXTRACT_PROMPT_OVERHEAD_PER_LINE,
  STAGE1_STDIN_CEILING,
  extractEventPayload,
  packEventsForExtract,
  packedLineCost,
} from "../../src/intelligence/extract-prompt.js";

describe("packEventsForExtract", () => {
  const batch = DEFAULT_CONFIG.extraction.batch_size;
  const maxLen = DEFAULT_CONFIG.extraction.max_content_length;

  it("packs short lines into fewer chunks than batch_size slicing", () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      content: "x".repeat(100),
      id: String(i),
    }));
    const packed = packEventsForExtract(events, batch, maxLen);
    expect(packed.length).toBeLessThan(Math.ceil(200 / batch));
    expect(packed.flat()).toHaveLength(200);
  });

  it("keeps full-length lines at most batch_size per chunk", () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      content: "y".repeat(maxLen),
      id: String(i),
    }));
    const packed = packEventsForExtract(events, batch, maxLen);
    expect(packed.every((c) => c.length <= batch)).toBe(true);
  });

  it("never packs a candidate payload over the stage-1 line budget", () => {
    const events = Array.from({ length: 80 }, (_, i) => ({
      content: "z".repeat(maxLen),
      role: "user" as const,
      occurred_at: null,
      id: String(i),
    }));
    const packed = packEventsForExtract(events, batch, maxLen);
    const budget = batch * maxLen;
    for (const chunk of packed) {
      const cost = chunk.reduce(
        (n, e) => n + Math.min(e.content?.length ?? 0, maxLen),
        0,
      );
      expect(cost).toBeLessThanOrEqual(budget);
      const stdin = JSON.stringify(chunk.map(extractEventPayload));
      expect(stdin.length).toBeLessThanOrEqual(STAGE1_STDIN_CEILING);
    }
  });

  it("overhead is the empty candidate JSON wrapper", () => {
    expect(EXTRACT_PROMPT_OVERHEAD_PER_LINE).toBe(
      JSON.stringify(
        extractEventPayload({ role: "assistant", content: "", occurred_at: null }),
      ).length,
    );
    expect(packedLineCost("abc", maxLen)).toBe(3 + EXTRACT_PROMPT_OVERHEAD_PER_LINE);
    expect(packedLineCost("x".repeat(maxLen + 50), maxLen)).toBe(
      maxLen + EXTRACT_PROMPT_OVERHEAD_PER_LINE,
    );
  });
});
