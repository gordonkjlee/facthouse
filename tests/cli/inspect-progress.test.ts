import { describe, it, expect } from "vitest";
import { createInspectProgress } from "../../src/cli/inspect-progress.js";

describe("createInspectProgress", () => {
  it("is silent when disabled", () => {
    const chunks: string[] = [];
    const p = createInspectProgress({
      enabled: false,
      write: (s) => chunks.push(s),
      isTty: true,
    });
    p.phase("Loading");
    p.tick(1, 2, "Linking Data");
    p.stop();
    expect(chunks).toEqual([]);
  });

  it("rewrites one TTY line with counts and a trailing newline on stop", () => {
    const chunks: string[] = [];
    const p = createInspectProgress({
      enabled: true,
      write: (s) => chunks.push(s),
      isTty: true,
    });
    p.phase("Loading inspect graph…");
    p.tick(20, 100, "Linking Data");
    p.stop();
    expect(chunks.some((c) => c.includes("Loading inspect graph…"))).toBe(true);
    expect(chunks.some((c) => c.includes("Linking Data  20/100"))).toBe(true);
    expect(chunks.at(-1)).toBe("\n");
  });

  it("writes newlines when not a TTY", () => {
    const chunks: string[] = [];
    const p = createInspectProgress({
      enabled: true,
      write: (s) => chunks.push(s),
      isTty: false,
    });
    p.phase("Loading inspect graph…");
    p.stop();
    expect(chunks[0]).toBe("Loading inspect graph…\n");
  });
});
