import { describe, it, expect } from "vitest";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
import type { SessionFact, Fact } from "../../src/types/data.js";
import type { ClassifiedFact } from "../../src/intelligence/types.js";
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeFact = (content: string, hint?: string): SessionFact => ({
  id: "test-id",
  session_id: "s1",
  content,
  content_hash: "hash",
  source_origin: "explicit" as const,
  source_event_id: null,
  domain_hint: hint ?? null,
  confidence: null,
  importance: null,
  source_tool: null,
  capture_context: null,
  consolidation_id: null,
  created_at: new Date().toISOString(),
});

const fakeFact2 = (content: string, domain: string): Fact => ({
  id: "existing-id",
  content,
  domain,
  subdomain: null,
  confidence: 0.7,
  importance: 0.5,
  source_type: "conversation",
  source_tool: null,
  source_id: null,
  status: "active" as const,
  superseded_by: null,
  is_latest: true,
  created_at: new Date().toISOString(),
  valid_from: null,
  valid_until: null,
  system_retired_at: null,
  session_id: null,
  capture_context: null,
  access_count: 0,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const provider = createHeuristicProvider(PERSONAL_VOCABULARY);

describe("classifyFacts", () => {
  it("classifies preference content as 'preferences'", async () => {
    const result = await provider.classifyFacts([fakeFact("I prefer dark roast")], "");
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("preferences");
  });

  it("classifies profile content as 'profile'", async () => {
    const result = await provider.classifyFacts([fakeFact("My name is Alex")], "");
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("profile");
  });

  it("classifies medical content as 'medical'", async () => {
    const result = await provider.classifyFacts(
      [fakeFact("I'm allergic to aspirin")],
      "",
    );
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("medical");
  });

  it("classifies people content as 'people'", async () => {
    const result = await provider.classifyFacts(
      [fakeFact("My partner Robin loves sushi")],
      "",
    );
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("people");
  });

  it("classifies work content as 'work'", async () => {
    const result = await provider.classifyFacts(
      [fakeFact("The project deadline is Friday")],
      "",
    );
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("work");
  });

  it("classifies unknown content as 'general'", async () => {
    const result = await provider.classifyFacts(
      [fakeFact("Something with no signal")],
      "",
    );
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("general");
  });

  // Every case above is first person, which is how this went unnoticed. The
  // patterns were written for "I prefer coffee", but capture_fact is called by
  // an AI recording a fact *about* its user, so content arrives in the third
  // person — and `\bprefer\b` does not match "prefers". Identity and preference
  // facts fell to `general`, leaving get_profile, get_preferences and
  // memory://profile empty for anyone on the fallback provider.
  describe.each([
    ["The user is called Alex Rivera", "profile"],
    ["The user lives in Springfield", "profile"],
    ["The user was born in 1990", "profile"],
    ["The user's occupation is platform engineer", "profile"],
    ["The user prefers dark roast coffee", "preferences"],
    ["The user likes long walks", "preferences"],
    ["The user dislikes instant coffee", "preferences"],
    ["The user is allergic to peanuts", "medical"],
    ["The user has a partner called Robin", "people"],
    ["The user is working on the Acme project", "work"],
  ])("third-person capture: %s", (content, expected) => {
    it(`routes to '${expected}'`, async () => {
      const result = await provider.classifyFacts([fakeFact(content)], "");
      expect(result[0].domain).toBe(expected);
    });
  });

  it("keeps a fact about a person with that person, not their preference", () => {
    // "My partner Robin loves sushi" matches both people and preferences. The
    // relationship noun says who the fact concerns, so people must win. This
    // previously held only by accident, because `\blove\b` missed "loves".
    return provider
      .classifyFacts([fakeFact("My partner Robin loves sushi")], "")
      .then((r) => expect(r[0].domain).toBe("people"));
  });

  it("domain_hint overrides keyword detection", async () => {
    // Content matches "preferences" keywords, but hint says "medical"
    const result = await provider.classifyFacts(
      [fakeFact("I prefer dark roast", "medical")],
      "",
    );
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("medical");
  });

  it("preserves id and content on classified output", async () => {
    const input = fakeFact("My name is Alex");
    const result = await provider.classifyFacts([input], "");
    expect(result[0].id).toBe(input.id);
    expect(result[0].content).toBe(input.content);
  });
});

describe("extractEntities", () => {
  // This block used to assert the fallback pulled "Robin" out of "my partner
  // Robin loves sushi" and labelled the edge partner_of. Those rules are gone.
  //
  // They were a personal ontology hardcoded into a general engine: partner, wife,
  // husband, sister, son. A corporate store's relationships are supplier, account
  // manager, on-call, escalation contact — no fixed list covers both, and the
  // engine cannot know which it is looking at. Guessing was the same mistake as
  // shipping a domain vocabulary, on a different axis.
  //
  // So the contract is now: entity extraction requires an LLM. An honestly empty
  // result beats a personal guess that is wrong for most stores.

  it("extracts nothing — it has no rules, and that is the point", async () => {
    const result = await provider.extractEntities([
      fakeFact("my partner Robin loves sushi"),
      fakeFact("The sev1 postmortem was led by Priya"),
    ]);

    expect(result.size).toBe(0);
  });

  it("does not invent a personal ontology for a corporate store", async () => {
    // The regression this guards: reintroducing a "relationship keyword" list
    // would match the first of these and never the second, and would be
    // confidently wrong about what an account manager is.
    const result = await provider.extractEntities([
      fakeFact("my wife Alice is a doctor"),
      fakeFact("our supplier Acme missed the SLA"),
    ]);

    expect(result.size).toBe(0);
  });
});


describe("detectSupersession", () => {
  it("detects supersession when negation signal present", async () => {
    // Requires negation words AND word overlap > 0.3 with different content
    const newFact: ClassifiedFact = {
      id: "new-id",
      content: "I no longer prefer drinking coffee every day",
      domain: "preferences",
      subdomain: null,
    };

    const existing = fakeFact2(
      "I prefer drinking coffee every day",
      "preferences",
    );

    const result = await provider.detectSupersession(newFact, [existing]);

    expect(result).not.toBeNull();
    expect(result!.existingFactId).toBe("existing-id");
  });

  it("does NOT supersede without negation even at high similarity", async () => {
    // "I prefer dark roast coffee from Colombia" vs "I prefer dark roast coffee"
    // High overlap but no negation — this is detail addition, not contradiction
    const newFact: ClassifiedFact = {
      id: "new-id",
      content: "I prefer dark roast coffee from Colombia",
      domain: "preferences",
      subdomain: null,
    };

    const existing = fakeFact2(
      "I prefer dark roast coffee",
      "preferences",
    );

    const result = await provider.detectSupersession(newFact, [existing]);
    expect(result).toBeNull();
  });

  it("correctly rejects supersession when content-word overlap is insufficient (D4)", async () => {
    // Negation present but facts are about different beverages.
    // After excluding stop words and transition markers ("now", "instead"),
    // content-word sets are {longer, prefer, light, roast, tea} (5) and
    // {prefer, dark, roast, coffee} (4). Intersection = {prefer, roast} = 2,
    // union = 7, Jaccard ≈ 0.29 — just below the 0.3 threshold.
    // Correctly rejected. This pins current behaviour: a future tokeniser
    // or threshold change that makes this fire should be a deliberate decision.
    const newFact: ClassifiedFact = {
      id: "new-id",
      content: "I no longer prefer light roast tea",
      domain: "preferences",
      subdomain: null,
    };

    const existing = fakeFact2("I prefer dark roast coffee", "preferences");
    const result = await provider.detectSupersession(newFact, [existing]);
    expect(result).toBeNull();
  });

  it("does NOT supersede 'I changed jobs' against existing work facts (D5)", async () => {
    // "changed" was removed from NEGATION_WORDS — should not trigger supersession
    const newFact: ClassifiedFact = {
      id: "new-id",
      content: "I changed jobs last year",
      domain: "work",
      subdomain: null,
    };

    const existing = fakeFact2("I work at ACME every day", "work");
    const result = await provider.detectSupersession(newFact, [existing]);
    expect(result).toBeNull();
  });

  it("returns null for unrelated facts", async () => {
    const newFact: ClassifiedFact = {
      id: "new-id",
      content: "I enjoy hiking on weekends",
      domain: "preferences",
      subdomain: null,
    };

    const existing = fakeFact2("My name is Alex", "profile");

    const result = await provider.detectSupersession(newFact, [existing]);
    expect(result).toBeNull();
  });

  it("skips non-active or non-latest facts", async () => {
    const newFact: ClassifiedFact = {
      id: "new-id",
      content: "Prefers tea",
      domain: "preferences",
      subdomain: null,
    };

    const superseded = {
      ...fakeFact2("Prefers coffee", "preferences"),
      status: "superseded" as const,
      is_latest: false,
    };

    const result = await provider.detectSupersession(newFact, [superseded]);
    expect(result).toBeNull();
  });
});

describe("reconcile", () => {
  it("returns 'noop' for exact content match", async () => {
    const candidate = fakeFact("My name is Alex");
    const existing = fakeFact2("My name is Alex", "profile");

    const decision = await provider.reconcile(candidate, [existing]);
    expect(decision.kind).toBe("noop");
  });

  it("returns 'add' for new content with no similar facts", async () => {
    const candidate = fakeFact("I prefer dark roast coffee");

    const decision = await provider.reconcile(candidate, []);
    expect(decision.kind).toBe("add");
  });

  it("returns 'add' when similar facts exist but content differs", async () => {
    const candidate = fakeFact("I prefer dark roast coffee");
    const existing = fakeFact2("I prefer light roast coffee", "preferences");

    const decision = await provider.reconcile(candidate, [existing]);
    expect(decision.kind).toBe("add");
  });

  it("is case-insensitive for dedup", async () => {
    const candidate = fakeFact("my name is alex");
    const existing = fakeFact2("My Name Is Alex", "profile");

    const decision = await provider.reconcile(candidate, [existing]);
    expect(decision.kind).toBe("noop");
  });
});

describe("summarise", () => {
  it("produces summary with domain counts from graduated facts", async () => {
    const sessionFacts = [fakeFact("a"), fakeFact("b"), fakeFact("c")];
    const graduatedFacts = [
      fakeFact2("My name is Alex", "profile"),
      fakeFact2("I prefer dark roast", "preferences"),
      fakeFact2("I'm allergic to aspirin", "medical"),
    ];

    const result = await provider.summarise(sessionFacts, graduatedFacts);

    expect(result.summary).toContain("3 facts");
    expect(result.summary).toContain("profile");
    expect(result.summary).toContain("preferences");
    expect(result.summary).toContain("medical");
    expect(result.openThreads).toEqual([]);
  });

  it("returns 'No facts graduated.' when no graduated facts", async () => {
    const result = await provider.summarise([fakeFact("a")], []);

    expect(result.summary).toBe("No facts graduated.");
    expect(result.openThreads).toEqual([]);
  });

  it("counts by actual domain not domain_hint", async () => {
    const sessionFacts = [fakeFact("Something random")];
    const graduatedFacts = [fakeFact2("Something random", "medical")];

    const result = await provider.summarise(sessionFacts, graduatedFacts);
    expect(result.summary).toContain("medical");
  });
});
