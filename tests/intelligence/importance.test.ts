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
const { defaultServerConfig } = await import("../../src/config.js");
const { CORE_DOMAINS } = await import("../../src/schemas/domains.js");

let db: Db;

function manager(configOverride?: Record<string, unknown>) {
  const sessionManager = createSessionManager(db);
  sessionManager.startSession("importance-test", null);
  return createFactManager(db, sessionManager, {
    intelligence: createHeuristicProvider(),
    serverConfig: { ...defaultServerConfig(), ...configOverride },
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
      capture: { default_confidence: 0.7, importance_defaults: { preferences: 0.1 } },
    });
    fm.captureFact({ content: "The user prefers dark roast coffee" });
    await fm.runConsolidate();

    expect(importanceOf("dark roast")).toBe(0.1);
  });

  it("falls back to the baseline for a domain with no default", async () => {
    // A periphery domain the registry has never heard of.
    const fm = manager({
      capture: { default_confidence: 0.7, importance_defaults: {} },
    });
    fm.captureFact({ content: "The user is allergic to peanuts" });
    await fm.runConsolidate();

    expect(importanceOf("allergic")).toBe(0.5);
  });

  it("ships a default for every core domain", () => {
    // A core domain without one silently reintroduces the flat-0.5 bug for its
    // facts alone, which is harder to spot than the original.
    for (const domain of CORE_DOMAINS) {
      expect(typeof domain.importance).toBe("number");
      expect(domain.importance).toBeGreaterThan(0);
      expect(domain.importance).toBeLessThanOrEqual(1);
    }
  });

  it("generates the config defaults from the registry rather than a second list", () => {
    const shipped = defaultServerConfig().capture.importance_defaults;
    for (const domain of CORE_DOMAINS) {
      expect(shipped[domain.name]).toBe(domain.importance);
    }
  });
});
