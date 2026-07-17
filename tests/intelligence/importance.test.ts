/**
 * Importance resolution.
 *
 * data-model.md specifies three layers, in priority order: the calling
 * assistant's explicit value, the user's config default for the domain, then a
 * neutral baseline. Consolidation adds a provider's LLM signal between the
 * first two.
 *
 * **Only the first and last were reachable.** capture_fact stamped
 * `importance ?? DEFAULT_IMPORTANCE` at write time, so the column was never
 * null; graduation resolves `importance ?? importance_signal ?? domain default
 * ?? baseline`, and a non-null first link short-circuits the rest. Both middle
 * layers were dead code. Meanwhile `capture.importance_defaults` shipped as
 * `{}`, so even the config layer had nothing in it.
 *
 * The effect was total: every fact scored 0.5. "The user is allergic to
 * peanuts" ranked exactly level with "Minor trivial detail". Every ranked
 * retrieval — which is the whole escape from gating on a classifier's label —
 * was sorting by a constant.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { createSessionManager } = await import("../../src/tools/session-manager.js");
const { createFactManager } = await import("../../src/tools/fact-manager.js");
const { createHeuristicProvider } = await import("../../src/intelligence/heuristic.js");
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";
const { defaultServerConfig } = await import("../../src/config.js");

let db: Db;

function manager(configOverride?: Record<string, unknown>) {
  const sessionManager = createSessionManager(db);
  sessionManager.startSession("importance-test", null);
  return createFactManager(db, sessionManager, {
    intelligence: createHeuristicProvider(PERSONAL_VOCABULARY),
    // The engine ships no vocabulary, so a test about calibration has to
    // declare one — exactly as a user does.
    serverConfig: {
      ...defaultServerConfig(),
      domains: PERSONAL_VOCABULARY,
      ...configOverride,
    },
  });
}

/** Importance of the single graduated fact matching a content fragment. */
function importanceOf(fragment: string): number {
  const row = db
    .prepare(`SELECT importance FROM facts WHERE content LIKE ?`)
    .get(`%${fragment}%`) as { importance: number } | undefined;
  if (!row) throw new Error(`no graduated fact matching "${fragment}"`);
  return row.importance;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
});

afterEach(() => closeDatabase(db));

describe("importance resolution", () => {
  it("gives a domain's facts that domain's default, with no hint from the caller", async () => {
    // The ordinary case: an assistant captures a fact and passes no importance
    // and no domain_hint. Previously everything here landed on 0.5.
    const fm = manager();
    fm.captureFact({ content: "The user is allergic to peanuts" });
    fm.captureFact({ content: "The user prefers dark roast coffee" });
    await fm.runConsolidate();

    expect(importanceOf("allergic")).toBe(0.9); // medical
    expect(importanceOf("dark roast")).toBe(0.4); // preferences
  });

  it("ranks safety above casual preference — the calibration that matters", async () => {
    const fm = manager();
    fm.captureFact({ content: "The user is allergic to peanuts" });
    fm.captureFact({ content: "The user prefers dark roast coffee" });
    await fm.runConsolidate();

    expect(importanceOf("allergic")).toBeGreaterThan(importanceOf("dark roast"));
  });

  it("does not score every fact identically", async () => {
    // The regression in one assertion: if this collapses to a single value,
    // every ranked retrieval in the product is sorting by a constant.
    const fm = manager();
    for (const content of [
      "The user is allergic to peanuts",
      "The user is called Alex Rivera",
      "The user has a partner called Robin",
      "The user prefers dark roast coffee",
      "Minor trivial detail",
    ]) {
      fm.captureFact({ content });
    }
    await fm.runConsolidate();

    const scores = (
      db.prepare(`SELECT importance FROM facts`).all() as Array<{ importance: number }>
    ).map((r) => r.importance);

    expect(new Set(scores).size).toBeGreaterThan(1);
  });

  it("lets the caller's explicit value win over the domain default", async () => {
    // Layer 1. The assistant has conversational context the domain does not.
    const fm = manager();
    fm.captureFact({ content: "The user prefers dark roast coffee", importance: 0.95 });
    await fm.runConsolidate();

    expect(importanceOf("dark roast")).toBe(0.95);
  });

  it("lets a user's config override the shipped default", async () => {
    // Layer 2 is the user's calibration, not ours. Someone who does not care
    // about preferences should be able to say so.
    const fm = manager({
      domains: [{ name: "preferences", subdomains: [], patterns: ["prefers?"], importance: 0.1 }],
    });
    fm.captureFact({ content: "The user prefers dark roast coffee" });
    await fm.runConsolidate();

    expect(importanceOf("dark roast")).toBe(0.1);
  });

  it("falls back to the baseline for a domain with no default", async () => {
    // A periphery domain the registry has never heard of.
    const fm = manager({
      domains: [{ name: "medical", subdomains: [], patterns: ["allerg"] }], // no importance declared
    });
    fm.captureFact({ content: "The user is allergic to peanuts" });
    await fm.runConsolidate();

    expect(importanceOf("allergic")).toBe(0.5);
  });

  it("a vocabulary that declares importance gets it applied", () => {
    // The fixture is a test's own vocabulary, not a shipped one. A domain
    // without an importance silently reintroduces the flat-0.5 bug for its facts
    // alone, which is harder to spot than the original.
    for (const domain of PERSONAL_VOCABULARY) {
      expect(typeof domain.importance).toBe("number");
      expect(domain.importance!).toBeGreaterThan(0);
      expect(domain.importance!).toBeLessThanOrEqual(1);
    }
  });

  it("ships no vocabulary at all — the engine has no categories", () => {
    // The engine cannot know whether this store is a life, a company or a
    // research programme, so it offers no domains and no calibration. Any it
    // shipped would be wrong for someone.
    expect(defaultServerConfig().domains).toEqual([]);
  });

  it("carries importance on the domain, not in a parallel map", () => {
    // One definition. A separate map keyed by domain name was a second home for
    // one value, and two homes are how they drift.
    for (const domain of PERSONAL_VOCABULARY) {
      expect(typeof domain.importance).toBe("number");
    }
  });

  it("routes everything to the fallback when no vocabulary is configured", async () => {
    // The engine ships no domains. A keyword classifier with no keywords cannot
    // route, and saying so is more honest than inventing a vocabulary — which is
    // what made this a personal-only product.
    const sessionManager = createSessionManager(db);
    sessionManager.startSession("no-vocab", null);
    const fm = createFactManager(db, sessionManager, {
      intelligence: createHeuristicProvider([]),
      serverConfig: { ...defaultServerConfig(), domains: [] },
    });
    fm.captureFact({ content: "The user is allergic to peanuts" });
    await fm.runConsolidate();

    const row = db.prepare(`SELECT domain FROM facts`).get() as { domain: string };
    expect(row.domain).toBe("general");
  });
});
