import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EXTRACT_CONTEXT_CONTRACT,
  EXTRACT_RELATED_K_CAP,
  SUBJECT_MARKING_CONTRACT,
  REFERENT_CAP,
  capReferents,
  extractEventPayload,
  extractTodayUtcDate,
  parseExtractedIso,
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
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/said_at/);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/Never guess a calendar day/);
  });

  it("said_at is utterance time, never ingest time", () => {
    expect(
      extractEventPayload({
        role: "user",
        content: "I went to the beach yesterday",
        occurred_at: "2026-08-25T18:00:00.000Z",
      }).said_at,
    ).toBe("2026-08-25T18:00:00.000Z");
    expect(
      extractEventPayload({
        role: "user",
        content: "I went to the beach yesterday",
      }).said_at,
    ).toBeNull();
  });

  it("parseExtractedIso keeps real days and drops hedges", () => {
    expect(parseExtractedIso("2026-08-25")).toBe("2026-08-25T00:00:00.000Z");
    expect(parseExtractedIso("2026-08-25T18:00:00Z")).toBe(
      "2026-08-25T18:00:00.000Z",
    );
    expect(parseExtractedIso("yesterday")).toBeNull();
    expect(parseExtractedIso("about 2019")).toBeNull();
    expect(parseExtractedIso(null)).toBeNull();
  });

  it("extractTodayUtcDate is a calendar day", () => {
    expect(extractTodayUtcDate(new Date("2026-08-26T12:00:00.000Z"))).toBe(
      "2026-08-26",
    );
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

  it("subject marking is one contract both entity extractors import", () => {
    expect(SUBJECT_MARKING_CONTRACT).toMatch(/subject_of/);
    expect(SUBJECT_MARKING_CONTRACT).toMatch(/entities list ONLY/);
    expect(src("intelligence/cli.ts")).toMatch(/SUBJECT_MARKING_CONTRACT/);
    expect(src("intelligence/sampling.ts")).toMatch(/SUBJECT_MARKING_CONTRACT/);
    expect(src("intelligence/heuristic.ts")).not.toMatch(/SUBJECT_MARKING_CONTRACT/);
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
