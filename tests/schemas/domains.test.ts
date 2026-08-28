/**
 * Domain mechanics.
 *
 * This file used to assert a CORE registry — profile, preferences, medical,
 * people, work, defined in code and called the base of the engine. It wasn't a
 * base, it was a personal vocabulary: `medical` is meaningless to a corporate
 * user and `work` says nothing when everything is work. The engine now ships one
 * domain, `general`, and reads every other name from config.
 *
 * So these tests assert the *machinery* — canonicalisation, compiling a
 * configured vocabulary, reading its calibration, steering a classifier toward
 * what already exists. Not a vocabulary, because there isn't one to assert.
 */

import { describe, it, expect } from "vitest";
import type { DomainDef } from "../../src/types/config.js";

const {
  DEFAULT_DOMAIN,
  normaliseDomainName,
  routableNames,
  routableDomainList,
  compilePatterns,
  importanceDefaults,
  domainRoutingInstruction,
  mergeVocabulary,
} = await import("../../src/schemas/domains.js");

/** A vocabulary that is deliberately not personal — the point of the exercise. */
const CORPORATE: DomainDef[] = [
  {
    name: "incidents",
    description: "outages, severities, postmortems",
    subdomains: [],
    patterns: ["\\b(incident|outage|sev\\d|postmortem)\\b"],
    importance: 0.9,
  },
  {
    name: "clients",
    description: "accounts and their contacts",
    subdomains: [],
    patterns: ["\\b(client|account|contract)\\b"],
    importance: 0.7,
  },
  { name: "general", subdomains: [] },
];

describe("the engine ships no vocabulary", () => {
  it("knows exactly one domain by name, and it is the fallback", () => {
    expect(DEFAULT_DOMAIN).toBe("general");
  });

  it("has no opinion about a vocabulary it was never given", () => {
    expect(routableNames([])).toEqual([]);
    expect(compilePatterns([])).toEqual([]);
    expect(importanceDefaults([])).toEqual({});
  });

  it("routes a corporate vocabulary as readily as a personal one", () => {
    // The test that would have failed before: nothing in the engine knows what
    // an incident is, and it does not need to.
    expect(routableNames(CORPORATE)).toEqual(["incidents", "clients"]);
    expect(importanceDefaults(CORPORATE)).toEqual({ incidents: 0.9, clients: 0.7 });
  });
});

describe("normaliseDomainName", () => {
  it("passes a name through", () => {
    expect(normaliseDomainName("incidents")).toBe("incidents");
  });

  it("merges spelling variants so one domain cannot exist twice", () => {
    expect(normaliseDomainName("Incidents")).toBe("incidents");
    expect(normaliseDomainName("  CLIENTS  ")).toBe("clients");
    expect(normaliseDomainName("side projects")).toBe("side_projects");
  });

  it("keeps a domain it has never heard of", () => {
    // With no shipped vocabulary, "never heard of" is the normal case: every
    // domain is someone's. Coercing here would discard the only thing that made
    // the fact distinctive.
    expect(normaliseDomainName("sev1_postmortem")).toBe("sev1_postmortem");
  });

  it("falls back only when there is genuinely no value", () => {
    expect(normaliseDomainName(null)).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomainName(undefined)).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomainName("")).toBe(DEFAULT_DOMAIN);
    expect(normaliseDomainName("   ")).toBe(DEFAULT_DOMAIN);
  });

  it("is idempotent", () => {
    expect(normaliseDomainName(normaliseDomainName("Incidents"))).toBe("incidents");
  });
});

describe("compilePatterns", () => {
  it("compiles a configured vocabulary in its own order", () => {
    // Order is precedence: whoever writes the config decides what wins a tie.
    const compiled = compilePatterns(CORPORATE);
    expect(compiled.map((c) => c.name)).toEqual(["incidents", "clients"]);
  });

  it("skips domains with no patterns — only an LLM can route to those", () => {
    const compiled = compilePatterns([
      { name: "vibes", subdomains: [] },
      ...CORPORATE,
    ]);
    expect(compiled.map((c) => c.name)).not.toContain("vibes");
  });

  it("never compiles the fallback — nothing routes to it", () => {
    expect(compilePatterns(CORPORATE).map((c) => c.name)).not.toContain("general");
  });

  it("drops an invalid pattern rather than refusing to boot", () => {
    // A typo in one domain's config must not stop the server starting. The cost
    // is that domain routing poorly, not nothing working.
    const compiled = compilePatterns([
      { name: "broken", subdomains: [], patterns: ["([unclosed"] },
      { name: "fine", subdomains: [], patterns: ["\\bworks\\b"] },
    ]);
    expect(compiled.map((c) => c.name)).toEqual(["fine"]);
  });

  it("matches case-insensitively", () => {
    const [incidents] = compilePatterns(CORPORATE);
    expect(incidents.patterns[0].test("A SEV1 OUTAGE occurred")).toBe(true);
  });
});

describe("importanceDefaults", () => {
  it("reads calibration from the vocabulary that declares it", () => {
    expect(importanceDefaults(CORPORATE)).toEqual({ incidents: 0.9, clients: 0.7 });
  });

  it("omits a domain that declares none, leaving it to the baseline", () => {
    expect(importanceDefaults([{ name: "clients", subdomains: [] }])).toEqual({});
  });

  it("keys on the canonical spelling", () => {
    expect(
      importanceDefaults([{ name: "Incidents", subdomains: [], importance: 0.9 }]),
    ).toEqual({ incidents: 0.9 });
  });
});

describe("domainRoutingInstruction", () => {
  it("names the vocabulary in use so a classifier reuses it", () => {
    // The fragmentation control: a model shown "incidents" reuses it rather than
    // coining "outages". Steering, not forbidding.
    const instruction = domainRoutingInstruction(CORPORATE);
    expect(instruction).toContain("incidents");
    expect(instruction).toContain("clients");
  });

  it("includes each domain's description so it routes on meaning", () => {
    expect(domainRoutingInstruction(CORPORATE)).toContain("outages, severities, postmortems");
  });

  it("says so plainly when a store has no vocabulary yet", () => {
    // A legitimate state, not an error: the engine ships none, so the classifier
    // is choosing this store's vocabulary from scratch.
    expect(domainRoutingInstruction([])).toMatch(/no domains yet/i);
  });

  it("permits a new domain rather than closing the set", () => {
    // With no shipped vocabulary, forbidding new labels would route nothing.
    expect(domainRoutingInstruction(CORPORATE)).toMatch(/invent a new domain/i);
  });

  it("never offers the fallback as a routing destination", () => {
    const listed = domainRoutingInstruction(CORPORATE).split("Invent")[0];
    expect(listed).not.toContain("general (");
  });
});

describe("mergeVocabulary", () => {
  it("uses store names when config is empty — the default store state", () => {
    const merged = mergeVocabulary(
      [{ name: "warehouse", subdomains: [] }],
      [],
    );
    expect(domainRoutingInstruction(merged)).toMatch(/warehouse/);
    expect(domainRoutingInstruction(merged)).not.toMatch(/no domains yet/i);
  });

  it("overlays config importance onto a matching store domain", () => {
    const merged = mergeVocabulary(
      [{ name: "incidents", subdomains: ["sev"] }],
      [{ name: "incidents", subdomains: [], importance: 0.9 }],
    );
    expect(importanceDefaults(merged)).toEqual({ incidents: 0.9 });
    expect(merged[0]?.subdomains).toEqual(["sev"]);
  });

  it("does not treat warehouse and data-warehouse as one name", () => {
    const merged = mergeVocabulary(
      [
        { name: "warehouse", subdomains: [] },
        { name: "data-warehouse", subdomains: [] },
      ],
      [],
    );
    expect(merged.map((d) => d.name).sort()).toEqual([
      "data-warehouse",
      "warehouse",
    ]);
  });
});

describe("routableDomainList", () => {
  it("lists the configured names for prose", () => {
    expect(routableDomainList(CORPORATE)).toBe("incidents, clients");
  });

  it("is empty when nothing is configured", () => {
    expect(routableDomainList([])).toBe("");
  });
});
