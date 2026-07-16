/**
 * The domain registry — the single definition of the taxonomy.
 *
 * Two things are being protected here. First, that the fallback classifier
 * matches how facts are actually written: an AI records them in the third
 * person ("The user prefers dark roast"), and the patterns were originally
 * written for the first ("I prefer dark roast"), so every -s verb form missed
 * and the facts fell to `general`. Second, that an unknown domain from any
 * source is coerced rather than minted.
 */

import { describe, it, expect } from "vitest";

const {
  DOMAINS,
  DOMAIN_NAMES,
  ROUTABLE_DOMAIN_NAMES,
  DEFAULT_DOMAIN,
  isKnownDomain,
  normaliseDomain,
  routableDomainList,
  domainPromptList,
  domainPromptGuide,
} = await import("../../src/schemas/domains.js");

describe("registry shape", () => {
  it("names every domain the read tools query", () => {
    // get_profile, get_preferences and memory://profile query these by name; a
    // domain missing here is a tool that can never return anything.
    for (const required of ["profile", "preferences", "medical", "people", "work"]) {
      expect(DOMAIN_NAMES).toContain(required);
    }
  });

  it("includes the fallback domain but never routes to it", () => {
    expect(DOMAIN_NAMES).toContain(DEFAULT_DOMAIN);
    expect(ROUTABLE_DOMAIN_NAMES).not.toContain(DEFAULT_DOMAIN);
    expect(DOMAINS.find((d) => d.name === DEFAULT_DOMAIN)!.patterns).toEqual([]);
  });

  it("puts medical first so health facts win a first-match tie", () => {
    expect(DOMAINS[0].name).toBe("medical");
  });

  it("ranks people above preferences so a fact about someone stays about them", () => {
    // "My partner Robin loves sushi" matches both. The relationship noun says
    // who the fact concerns; the preference verb only says what it mentions.
    const order = DOMAIN_NAMES;
    expect(order.indexOf("people")).toBeLessThan(order.indexOf("preferences"));
  });

  it("has no duplicate names", () => {
    expect(new Set(DOMAIN_NAMES).size).toBe(DOMAIN_NAMES.length);
  });
});

describe("normaliseDomain — the gate", () => {
  it("passes through a known domain", () => {
    expect(normaliseDomain("preferences")).toBe("preferences");
  });

  it("coerces an unknown domain to the fallback rather than minting it", () => {
    // The failure this prevents: a provider answering "health" instead of
    // "medical" creates a domain that no tool queries, so the fact is stored,
    // counted in the stats, and permanently unretrievable.
    expect(normaliseDomain("health")).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomain("finance")).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomain("personal_info")).toBe(DEFAULT_DOMAIN);
  });

  it("accepts case and whitespace variants of a known domain", () => {
    // An LLM answering "Preferences" means preferences, not a new domain.
    expect(normaliseDomain("Preferences")).toBe("preferences");
    expect(normaliseDomain("  MEDICAL  ")).toBe("medical");
  });

  it("handles absent values", () => {
    expect(normaliseDomain(null)).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomain(undefined)).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomain("")).toBe(DEFAULT_DOMAIN);
  });

  it("is idempotent", () => {
    expect(normaliseDomain(normaliseDomain("health"))).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomain(normaliseDomain("Work"))).toBe("work");
  });
});

describe("isKnownDomain", () => {
  it("recognises known domains regardless of case", () => {
    expect(isKnownDomain("work")).toBe(true);
    expect(isKnownDomain("WORK")).toBe(true);
  });

  it("rejects unknown domains", () => {
    expect(isKnownDomain("health")).toBe(false);
  });
});

describe("prompt helpers", () => {
  it("derive from the registry rather than repeating it", () => {
    // These feed the LLM prompts. If they were hand-written strings they would
    // drift from the registry — which is exactly how the list ended up copied
    // into five places, two of which disagreed about `general`.
    for (const name of ROUTABLE_DOMAIN_NAMES) {
      expect(routableDomainList()).toContain(name);
      expect(domainPromptList()).toContain(name);
      expect(domainPromptGuide()).toContain(name);
    }
  });

  it("offers the fallback to the classifier but not to callers hinting a domain", () => {
    expect(domainPromptList()).toContain(DEFAULT_DOMAIN);
    expect(routableDomainList()).not.toContain(DEFAULT_DOMAIN);
  });

  it("describes each domain in the guide", () => {
    for (const d of DOMAINS) expect(domainPromptGuide()).toContain(d.description);
  });
});
