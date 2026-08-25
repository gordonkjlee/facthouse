import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EXTRACT_CONTEXT_CONTRACT,
  EXTRACT_RELATED_K_CAP,
  REFERENT_CAP,
  capReferents,
} from "../../src/intelligence/extract-prompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) =>
  readFileSync(path.join(here, "..", "..", "src", rel), "utf8");

describe("EXTRACT_CONTEXT_CONTRACT", () => {
  it("is the field-meaning contract, not a pronoun dictionary", () => {
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/candidate_events/);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/session_now/);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/referents/);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/CONTRADICTS long_term_memory/);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/small set of related graduated facts/);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/reminder_events/);
    expect(EXTRACT_CONTEXT_CONTRACT).not.toMatch(/pronoun resolution/i);
  });

  it("caps related K at eight", () => {
    expect(EXTRACT_RELATED_K_CAP).toBe(8);
    expect(src("intelligence/consolidate.ts")).toMatch(/relatedFactsForExtract/);
    expect(src("intelligence/consolidate.ts")).not.toMatch(
      /SELECT \* FROM facts\s+WHERE status = 'active' AND is_latest = 1/,
    );
  });

  it("is imported by both LLM extract providers", () => {
    expect(src("intelligence/sampling.ts")).toMatch(
      /EXTRACT_CONTEXT_CONTRACT/,
    );
    expect(src("intelligence/cli.ts")).toMatch(/EXTRACT_CONTEXT_CONTRACT/);
  });

  it("caps referents at eight without merging", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      phrase: `p${i}`,
      binding: `b${i}`,
    }));
    expect(capReferents(nine)).toHaveLength(REFERENT_CAP);
    expect(capReferents(nine)[0].phrase).toBe("p0");
    expect(capReferents(undefined)).toEqual([]);
  });
});
