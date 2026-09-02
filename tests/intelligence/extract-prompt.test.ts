import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DURABLE_FACT,
  EXTRACT_CONTEXT_CONTRACT,
  EXTRACT_DURABLE_JOB,
  EXTRACT_RELATED_K_CAP,
  SUBJECT_MARKING_CONTRACT,
  ENTITY_TYPE_PROMPT_CAP,
  entityTypeInstruction,
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
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/small set of related integrated facts/);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/reminder_events/);
    expect(EXTRACT_CONTEXT_CONTRACT).not.toMatch(/pronoun resolution/i);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/said_at/);
    expect(EXTRACT_CONTEXT_CONTRACT).toMatch(/Never guess a calendar day/);
  });

  it("said_at is utterance time, never copy time", () => {
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

  it("is the only definition of a durable fact", () => {
    expect(DURABLE_FACT).toMatch(/whatever this store is used for/);
    expect(DURABLE_FACT).toMatch(/Ignore ephemeral statements/);
    expect(DURABLE_FACT).not.toMatch(/medical information/i);
    expect(DURABLE_FACT).not.toMatch(/personal details/i);
    expect(EXTRACT_DURABLE_JOB.startsWith("You extract durable facts from conversation events")).toBe(
      true,
    );
    expect(EXTRACT_DURABLE_JOB).toContain(DURABLE_FACT);

    expect(src("intelligence/cli.ts")).toMatch(/EXTRACT_DURABLE_JOB/);
    expect(src("intelligence/sampling.ts")).toMatch(/EXTRACT_DURABLE_JOB/);
    expect(src("tools/capture-fact-description.ts")).toMatch(/DURABLE_FACT/);

    // A second inlined copy is how sampling listed medical/preferences while
    // CLI was already general. Import the constant; do not paraphrase it.
    expect(src("intelligence/cli.ts")).not.toMatch(
      /A durable fact is a stable piece/,
    );
    expect(src("intelligence/sampling.ts")).not.toMatch(
      /A durable fact is a stable piece/,
    );
    expect(src("intelligence/sampling.ts")).not.toMatch(/medical information/i);
    expect(src("intelligence/sampling.ts")).not.toMatch(/personal details/i);
    expect(src("tools/capture-fact-description.ts")).not.toMatch(
      /medical information/i,
    );
    expect(src("tools/capture-fact-description.ts")).not.toMatch(
      /personal details/i,
    );
    expect(src("tools/read-tools.ts")).not.toMatch(/medical info/i);
    expect(src("tools/read-tools.ts")).not.toMatch(/not knowing the user/);
  });

  it("subject marking is one contract both entity extractors import", () => {
    expect(SUBJECT_MARKING_CONTRACT).toMatch(/subject_of/);
    expect(SUBJECT_MARKING_CONTRACT).toMatch(/entities list ONLY/);
    expect(SUBJECT_MARKING_CONTRACT).toMatch(/role in this fact/);
    expect(SUBJECT_MARKING_CONTRACT).not.toMatch(/RDF/i);
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

describe("entityTypeInstruction", () => {
  it("says so when the store has no types yet", () => {
    expect(entityTypeInstruction([])).toMatch(/short lowercase type/i);
    expect(entityTypeInstruction([])).not.toMatch(/already in use/);
  });

  it("names types so extract reuses them", () => {
    const text = entityTypeInstruction(["dbt_model", "column"]);
    expect(text).toContain("dbt_model");
    expect(text).toContain("column");
    expect(text).toMatch(/never coin a synonym/i);
  });

  it("does not treat dbt_model and model as one type", () => {
    const text = entityTypeInstruction(["dbt_model", "model"]);
    expect(text).toContain("dbt_model");
    expect(text).toMatch(/\bmodel\b/);
  });

  it("caps the list so a large graph cannot blow the prompt", () => {
    const types = Array.from({ length: ENTITY_TYPE_PROMPT_CAP + 10 }, (_, i) => `t${i}`);
    const named = entityTypeInstruction(types);
    expect(named.split(", ").length).toBe(ENTITY_TYPE_PROMPT_CAP);
  });
});
