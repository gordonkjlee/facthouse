/**
 * The domain taxonomy — core plus periphery.
 *
 * The core is defined in code and seeded on init because the read tools and the
 * fallback patterns depend on those exact names, and because a classifier needs
 * an existing vocabulary to be consistent with. Everything beyond the core is
 * open: a user's own assistant may create domains this file has never heard of,
 * and those must survive intact.
 *
 * The rule these tests protect: a domain's spelling is canonicalised, but an
 * unrecognised domain is never coerced away. Coercion would discard the label
 * that made a fact distinctive — and it is precisely the facts that fit nothing
 * else which most need their own label.
 */

import { describe, it, expect } from "vitest";

const {
  CORE_DOMAINS,
  CORE_DOMAIN_NAMES,
  ROUTABLE_CORE_NAMES,
  DEFAULT_DOMAIN,
  isCoreDomain,
  normaliseDomainName,
  routableDomainList,
  domainPromptGuide,
  domainRoutingInstruction,
} = await import("../../src/schemas/domains.js");

describe("core registry", () => {
  it("names every domain the read tools query", () => {
    // get_profile, get_preferences and memory://profile query these by name; a
    // core domain missing here is a tool that can never return anything.
    for (const required of ["profile", "preferences", "medical", "people", "work"]) {
      expect(CORE_DOMAIN_NAMES).toContain(required);
    }
  });

  it("includes the fallback domain but never routes to it", () => {
    expect(CORE_DOMAIN_NAMES).toContain(DEFAULT_DOMAIN);
    expect(ROUTABLE_CORE_NAMES).not.toContain(DEFAULT_DOMAIN);
    expect(CORE_DOMAINS.find((d) => d.name === DEFAULT_DOMAIN)!.patterns).toEqual([]);
  });

  it("puts medical first so health facts win a first-match tie", () => {
    expect(CORE_DOMAINS[0].name).toBe("medical");
  });

  it("ranks people above preferences so a fact about someone stays about them", () => {
    expect(CORE_DOMAIN_NAMES.indexOf("people")).toBeLessThan(
      CORE_DOMAIN_NAMES.indexOf("preferences"),
    );
  });

  it("has no duplicate names", () => {
    expect(new Set(CORE_DOMAIN_NAMES).size).toBe(CORE_DOMAIN_NAMES.length);
  });
});

describe("normaliseDomainName", () => {
  it("passes a core domain through unchanged", () => {
    expect(normaliseDomainName("preferences")).toBe("preferences");
  });

  it("keeps a domain outside the core rather than coercing it away", () => {
    // The taxonomy is open beyond the core. A user's assistant knows their life
    // better than this list does, and a fact that fits nothing else is the one
    // whose label carries the most information — flattening it to `general`
    // destroys exactly what made it worth keeping.
    expect(normaliseDomainName("fitness")).toBe("fitness");
    expect(normaliseDomainName("finance")).toBe("finance");
    expect(isCoreDomain("fitness")).toBe(false);
  });

  it("merges spelling variants so one domain cannot exist twice", () => {
    // Canonicalising spelling is not the same as coercing meaning.
    expect(normaliseDomainName("Preferences")).toBe("preferences");
    expect(normaliseDomainName("  MEDICAL  ")).toBe("medical");
    expect(normaliseDomainName("side projects")).toBe("side_projects");
  });

  it("falls back only when there is genuinely no value", () => {
    expect(normaliseDomainName(null)).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomainName(undefined)).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomainName("")).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomainName("   ")).toBe(DEFAULT_DOMAIN);
  });

  it("is idempotent", () => {
    expect(normaliseDomainName(normaliseDomainName("Fitness"))).toBe("fitness");
    expect(normaliseDomainName(normaliseDomainName("Work"))).toBe("work");
  });
});

describe("isCoreDomain", () => {
  it("recognises core domains regardless of spelling", () => {
    expect(isCoreDomain("work")).toBe(true);
    expect(isCoreDomain("WORK")).toBe(true);
  });

  it("does not claim a periphery domain as core", () => {
    expect(isCoreDomain("health")).toBe(false);
  });
});

describe("domainRoutingInstruction", () => {
  it("names the core vocabulary so a classifier reuses rather than coins", () => {
    const instruction = domainRoutingInstruction();
    for (const name of CORE_DOMAIN_NAMES) expect(instruction).toContain(name);
  });

  it("names domains already in use, which is what keeps the vocabulary stable", () => {
    // Steering reuse is the fragmentation control: a model shown "medical"
    // reuses it instead of coining "health". Nothing forbids a new label.
    const instruction = domainRoutingInstruction(["fitness", "finance"]);
    expect(instruction).toContain("fitness");
    expect(instruction).toContain("finance");
  });

  it("permits a genuinely new domain rather than closing the set", () => {
    expect(domainRoutingInstruction()).toMatch(/invent a new domain|new domain/i);
  });

  it("does not repeat a domain already in the core", () => {
    const instruction = domainRoutingInstruction(["medical", "fitness"]);
    expect(instruction.match(/medical/g)!.length).toBeLessThanOrEqual(2); // list + guide
  });
});

describe("prompt helpers", () => {
  it("derive from the registry rather than repeating it", () => {
    for (const name of ROUTABLE_CORE_NAMES) {
      expect(routableDomainList()).toContain(name);
      expect(domainPromptGuide()).toContain(name);
    }
  });

  it("offers the fallback to a classifier but not to callers hinting a domain", () => {
    expect(routableDomainList()).not.toContain(DEFAULT_DOMAIN);
  });

  it("describes each core domain in the guide", () => {
    for (const d of CORE_DOMAINS) expect(domainPromptGuide()).toContain(d.description);
  });
});
