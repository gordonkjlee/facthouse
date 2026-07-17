import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertFact } = await import("../../src/db/facts.js");
const { createSource } = await import("../../src/db/sources.js");
const { getLatestConsolidation, getLatestSummarised } = await import(
  "../../src/db/consolidations.js"
);
const { buildProfile, buildBriefing, PROFILE_URI, BRIEFING_URI } = await import(
  "../../src/tools/resources.js"
);

let db: Db;
let sourceId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
  sourceId = createSource(db, {
    type: "test",
    tool_id: null,
    raw_content: "x",
    metadata: {},
  }).id;
});

afterEach(() => closeDatabase(db));

function fact(
  content: string,
  domain: string,
  subdomain: string | null = null,
  importance = 0.5,
) {
  return insertFact(db, {
    content,
    domain,
    subdomain,
    confidence: 0.9,
    importance,
    source_type: "conversation",
    source_tool: null,
    source_id: sourceId,
    session_id: null,
    capture_context: null,
    source_quality: "explicit",
  });
}

/** Insert a consolidation row directly — open_threads is JSON-encoded TEXT. */
function consolidation(
  id: string,
  summary: string | null,
  openThreads: string[] | null,
  createdAt: string,
) {
  db.prepare(
    `INSERT INTO consolidations
       (id, session_id, facts_in, facts_graduated, facts_rejected,
        entities_created, entities_linked, supersessions,
        summary, open_threads, last_event_sequence, created_at)
     VALUES (?, NULL, 1, 1, 0, 0, 0, 0, ?, ?, 0, ?)`,
  ).run(id, summary, openThreads ? JSON.stringify(openThreads) : null, createdAt);
}

describe("consolidation read helpers", () => {
  it("returns null when nothing has consolidated", () => {
    expect(getLatestConsolidation(db)).toBeNull();
    expect(getLatestSummarised(db)).toBeNull();
  });

  it("parses open_threads back from its JSON column", () => {
    consolidation("c1", "did a thing", ["follow up on X", "confirm Y"], "2026-01-01T00:00:00Z");
    const c = getLatestConsolidation(db);
    expect(c!.open_threads).toEqual(["follow up on X", "confirm Y"]);
  });

  it("survives malformed open_threads rather than throwing", () => {
    consolidation("c1", "s", null, "2026-01-01T00:00:00Z");
    db.prepare(`UPDATE consolidations SET open_threads = ? WHERE id = ?`).run("{not json", "c1");
    expect(getLatestConsolidation(db)!.open_threads).toBeNull();
  });

  it("getLatestSummarised skips a newer row that has no summary yet", () => {
    // A run records its row before its summary exists, and no-op runs never get
    // one — so the newest row is often not the newest narrative.
    consolidation("older", "the real narrative", ["thread"], "2026-01-01T00:00:00Z");
    consolidation("newer", null, null, "2026-06-01T00:00:00Z");

    expect(getLatestConsolidation(db)!.id).toBe("newer");
    expect(getLatestSummarised(db)!.id).toBe("older");
    expect(getLatestSummarised(db)!.summary).toBe("the real narrative");
  });
});

describe("memory://profile", () => {
  it("says so plainly when nothing is known", () => {
    expect(buildProfile(db)).toContain("Nothing captured yet");
  });

  it("renders key facts as markdown bullets", () => {
    fact("The sev1 outage had a postmortem", "incidents", null, 0.95);
    const md = buildProfile(db);
    expect(md).toContain("# Key facts");
    expect(md).toContain("- The sev1 outage had a postmortem");
  });

  it("orders by importance, most important first", () => {
    fact("Minor detail", "general", null, 0.1);
    fact("Core fact", "incidents", null, 0.99);
    const md = buildProfile(db);
    expect(md.indexOf("Core fact")).toBeLessThan(md.indexOf("Minor detail"));
  });

  it("includes the most important facts from any domain, not one fixed domain", () => {
    // The inverse of the old assertion. This used to require domain='profile'
    // only — the hardcoded weld. A general store's key facts span whatever
    // domains it uses; importance decides what leads, not a domain name.
    fact("The sev1 outage had a postmortem", "incidents", null, 0.95);
    fact("The Acme contract renews in March", "clients", null, 0.7);
    const md = buildProfile(db);
    expect(md).toContain("sev1 outage");
    expect(md).toContain("Acme contract");
  });
});

describe("memory://briefing", () => {
  it("says so plainly when nothing is known", () => {
    expect(buildBriefing(db)).toContain("No knowledge captured yet");
  });

  it("assembles profile, narrative, open threads and recent knowledge", () => {
    fact("The user is called Alex", "profile", null, 0.9);
    fact("Prefers dark roast", "preferences", "food", 0.5);
    consolidation("c1", "Learned about coffee.", ["Confirm meeting times"], "2026-01-01T00:00:00Z");

    const md = buildBriefing(db);
    expect(md).toContain("# OpenMemory Briefing");
    expect(md).toContain("## Key facts");
    expect(md).toContain("The user is called Alex");
    expect(md).toContain("## Last consolidation");
    expect(md).toContain("Learned about coffee.");
    expect(md).toContain("## Open threads");
    expect(md).toContain("Confirm meeting times");
    expect(md).toContain("## Recent knowledge");
    expect(md).toContain("**preferences/food** — Prefers dark roast");
  });

  it("uses the last narrative, not a newer summary-less run", () => {
    fact("The user is called Alex", "profile", null, 0.9);
    consolidation("older", "the real narrative", null, "2026-01-01T00:00:00Z");
    consolidation("newer", null, null, "2026-06-01T00:00:00Z");
    expect(buildBriefing(db)).toContain("the real narrative");
  });

  it("omits sections that have no content rather than showing empty headings", () => {
    fact("The user is called Alex", "profile", null, 0.9);
    const md = buildBriefing(db);
    expect(md).not.toContain("## Last consolidation");
    expect(md).not.toContain("## Open threads");
  });

  it("stays within its ~100 line budget even with a lot of knowledge", () => {
    for (let i = 0; i < 60; i++) fact(`Profile detail ${i}`, "profile", null, 0.5);
    for (let i = 0; i < 60; i++) fact(`Preference ${i}`, "preferences", "food", 0.5);
    consolidation("c1", "A summary.", Array.from({ length: 20 }, (_, i) => `Thread ${i}`), "2026-01-01T00:00:00Z");

    const lines = buildBriefing(db).split("\n").length;
    expect(lines).toBeLessThanOrEqual(100);
  });

  it("exposes the URIs the spec names", () => {
    expect(PROFILE_URI).toBe("memory://profile");
    expect(BRIEFING_URI).toBe("memory://briefing");
  });
});

describe("consolidation notifies subscribers", () => {
  // The resources are only stale when graduated knowledge changes, and
  // consolidation is the only thing that changes it. Both entry points (the
  // scheduler and the `consolidate` tool) funnel through runConsolidate, so
  // the hook lives there.
  async function setup(onConsolidated: () => void) {
    const sessionMod = await import("../../src/tools/session-manager.js");
    const factMod = await import("../../src/tools/fact-manager.js");
    const heuristicMod = await import("../../src/intelligence/heuristic.js");
    const sessionManager = sessionMod.createSessionManager(db);
    sessionManager.startSession("test-client", null);
    const factManager = factMod.createFactManager(db, sessionManager, {
      intelligence: heuristicMod.createHeuristicProvider(PERSONAL_VOCABULARY),
      onConsolidated,
    });
    return { factManager };
  }

  it("fires after a run that did work", async () => {
    let fired = 0;
    const { factManager } = await setup(() => fired++);
    factManager.captureFact({ content: "The user is called Alex" });

    const result = await factManager.runConsolidate();
    expect(result.skipped).toBe(false);
    expect(fired).toBe(1);
  });

  it("does not fire for a skipped run — nothing changed to re-read", async () => {
    let fired = 0;
    const { factManager } = await setup(() => fired++);

    // Hold the advisory lock so the run skips.
    const lockMod = await import("../../src/db/consolidation-lock.js");
    lockMod.acquireLock(db, "someone-else");

    const result = await factManager.runConsolidate();
    expect(result.skipped).toBe(true);
    expect(fired).toBe(0);
  });

  it("a throwing subscriber never fails a committed consolidation", async () => {
    const { factManager } = await setup(() => {
      throw new Error("notification blew up");
    });
    factManager.captureFact({ content: "The user is called Alex" });

    // The facts are already written by this point; a notification problem must
    // not surface as a consolidation failure.
    await expect(factManager.runConsolidate()).resolves.toBeDefined();
  });
});
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";
