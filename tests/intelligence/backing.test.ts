import { describe, it, expect } from "vitest";
import { ASSENT_LEXICON, isAssentLine } from "../../src/intelligence/backing.js";

describe("isAssentLine", () => {
  it("matches the exported lexicon as a whole line", () => {
    expect(ASSENT_LEXICON).toContain("yes");
    expect(isAssentLine("yes")).toBe(true);
    expect(isAssentLine("  Yes.  ")).toBe(true);
    expect(isAssentLine("that's right")).toBe(true);
  });

  it("does not match yes as a substring", () => {
    expect(isAssentLine("yesterday")).toBe(false);
    expect(isAssentLine("yes, and bookings are the grain")).toBe(false);
  });
});
