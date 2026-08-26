/**
 * Coding-store eval: warehouse/agent transcripts without a coding plugin.
 *
 * Item 4's first-fact fixture is one personal sentence in Claude Code JSONL.
 * A coding day is mixed identifiers and business nouns, current tasks, and
 * huge tool dumps. This file is that shape, with synthetic names only.
 *
 * Two layers, same as first-fact:
 *
 *   1. Hermetic pipeline (always in `npm test`). A recording extractor stands
 *      in for the LLM. Heuristic extract is the control that must miss — if
 *      search hit events directly, the recording path would pass for the
 *      wrong reason.
 *   2. Live CLI (opt-in). `OPENMEMORY_REQUIRE_CODING_STORE_EVAL=1`
 *      (`npm run test:coding-store`) then *fails* when the CLI is missing
 *      rather than quietly verifying nothing. Discriminating rows: grain is
 *      searchable; a failing-join task does not graduate.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, closeDatabase } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { findEntity, SUBJECT_OF } from "../../src/db/entities.js";
import { consolidate } from "../../src/intelligence/consolidate.js";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
import { probeCliProvider } from "../../src/intelligence/cli.js";
import { pullSources } from "../../src/sources/pull.js";
import {
  encodeCursorProjectDir,
  encodeProjectDir,
} from "../../src/sources/resolve.js";
import { searchWithProvider } from "../../src/search/index.js";
import { lookupNamedSubject } from "../../src/search/entity.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { SessionEvent } from "../../src/types/data.js";
import type { ExtractedFact } from "../../src/intelligence/types.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SERVER = path.join(ROOT, "dist", "index.js");
const CLI = path.join(ROOT, "dist", "cli", "index.js");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "coding-store");

const GRAIN_FILE = path.join(FIXTURES, "grain.jsonl");
const IDENT_FILE = path.join(FIXTURES, "identifier.jsonl");
const EPH_FILE = path.join(FIXTURES, "ephemeral.jsonl");
const ASSENT_FILE = path.join(FIXTURES, "assent.jsonl");

const PROJECT_CWD = "C:\\dev\\app";
const GRAIN_FACT = "Bookings are the grain of the orders mart at Acme.";
const IDENT_FACT = "The stg_orders relation is missing booked_at.";

const required = process.env.OPENMEMORY_REQUIRE_CODING_STORE_EVAL === "1";

function probeLiveCli(): string | null {
  if (!existsSync(SERVER) || !existsSync(CLI)) return "dist/ is not built";
  if (!existsSync(GRAIN_FILE) || !existsSync(EPH_FILE)) {
    return "coding-store fixtures are missing";
  }
  const probe = probeCliProvider();
  if (!probe.available) {
    return `claude CLI not available (${probe.command.join(" ")} --version failed)`;
  }
  return null;
}

const unavailable = required ? probeLiveCli() : "not opted in";

let roots: string[] = [];

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function plantCursor(home: string, sessionId: string, fixture: string): void {
  const file = path.join(
    home,
    "projects",
    encodeCursorProjectDir(PROJECT_CWD),
    "agent-transcripts",
    sessionId,
    `${sessionId}.jsonl`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  copyFileSync(fixture, file);
}

function plantClaudeLines(home: string, sessionId: string, lines: string[]): void {
  const file = path.join(
    home,
    "projects",
    encodeProjectDir(PROJECT_CWD),
    `${sessionId}.jsonl`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => l + "\n").join(""), "utf-8");
}

function schemaDump(): string {
  const rows: string[] = [];
  for (let i = 0; i < 60; i++) {
    rows.push(
      `CREATE TABLE dim_widget_${i} (id INTEGER PRIMARY KEY, code TEXT NOT NULL);`,
    );
  }
  const dump = rows.join("\n");
  expect(dump.length).toBeGreaterThan(2000);
  expect(dump).not.toMatch(/stg_orders|bookings/i);
  return dump;
}

function contentsOf(response: {
  results?: Array<{ fact?: { content?: string } }>;
}): string[] {
  return (response.results ?? []).map((r) => r.fact?.content ?? "");
}

function hitsNeedle(
  response: { results?: Array<{ fact?: { content?: string } }> },
  needle: string,
): boolean {
  const n = needle.toLowerCase();
  return contentsOf(response).some((c) => c.toLowerCase().includes(n));
}

function episodeMentions(
  response: {
    episodes?: Array<{ events?: Array<{ content?: string | null; matched?: boolean }> }>;
  },
  needle: string,
): boolean {
  const n = needle.toLowerCase();
  return (response.episodes ?? []).some((s) =>
    s.events?.some((e) => (e.content ?? "").toLowerCase().includes(n)),
  );
}

function extractionConfig() {
  return { ...DEFAULT_CONFIG.extraction, enabled: true };
}

/**
 * Intended extract for these fixtures. Encodes what a general extractor
 * should keep vs drop — not a coding ontology. Live CLI is the check that
 * the real model agrees on the discriminating rows.
 */
function recordingExtractor() {
  const heuristic = createHeuristicProvider();
  let extractCalls = 0;
  return {
    extractCalls: () => extractCalls,
    provider: {
      ...heuristic,
      async extractFactsFromEvents(events: SessionEvent[]) {
        extractCalls += 1;
        const blob = events.map((e) => e.content ?? "").join("\n");
        const facts: ExtractedFact[] = [];
        if (/grain of the orders mart/i.test(blob)) {
          facts.push({
            content: GRAIN_FACT,
            domain_hint: "pipeline",
            entities: [
              { name: "bookings", type: "concept", relationship: SUBJECT_OF },
              { name: "orders mart", type: "system", relationship: "grain_of" },
            ],
          });
        }
        if (/stg_orders is missing booked_at/i.test(blob)) {
          facts.push({
            content: IDENT_FACT,
            domain_hint: "pipeline",
            entities: [
              {
                name: "stg_orders",
                type: "relation",
                relationship: SUBJECT_OF,
              },
            ],
          });
        }
        return { facts, degraded: false };
      },
    },
  };
}

async function pullCursorAndConsolidate(
  fixture: string,
  sessionId: string,
  recording: ReturnType<typeof recordingExtractor>["provider"],
) {
  const db = openDatabase(":memory:");
  applySchema(db);
  const home = path.join(tmp("om-coding-"), "cursor-home");
  plantCursor(home, sessionId, fixture);
  const pulled = pullSources(db, [
    { kind: "cursor", home, cwd: PROJECT_CWD },
  ]);
  const done = await consolidate(db, recording as never, {
    extraction: extractionConfig() as never,
  });
  return { db, pulled, done };
}

// ---------------------------------------------------------------------------
// Hermetic pipeline — always runs
// ---------------------------------------------------------------------------

describe("coding-store pipeline (recording extractor)", () => {
  it("fixtures exist", () => {
    expect(existsSync(GRAIN_FILE)).toBe(true);
    expect(existsSync(IDENT_FILE)).toBe(true);
    expect(existsSync(EPH_FILE)).toBe(true);
    expect(existsSync(ASSENT_FILE)).toBe(true);
  });

  it("pulls Cursor JSONL, extracts the grain, search and get_entity hit; heuristic does not", async () => {
    const rec = recordingExtractor();
    const { db, pulled, done } = await pullCursorAndConsolidate(
      GRAIN_FILE,
      "sess-coding-grain",
      rec.provider,
    );
    expect(pulled.events_inserted).toBeGreaterThan(0);
    expect(rec.extractCalls()).toBeGreaterThan(0);
    expect(done.skipped).toBe(false);
    expect(done.factsGraduated).toBeGreaterThan(0);

    const beforeStyle = await searchWithProvider(db, "bookings", null);
    expect(hitsNeedle(beforeStyle, "bookings")).toBe(true);
    expect(contentsOf(beforeStyle)).toContain(GRAIN_FACT);
    expect(beforeStyle.episodes).toEqual([]);

    const row = db
      .prepare(`SELECT domain FROM facts WHERE content = ?`)
      .get(GRAIN_FACT) as { domain: string };
    expect(row.domain).toBe("pipeline");
    expect(row.domain).not.toBe("general");
    expect(row.domain).not.toBe("profile");
    expect(row.domain).not.toBe("work");

    const about = lookupNamedSubject(db, "bookings");
    expect(about.found).toBe(true);
    expect(about.facts.some((f) => f.is_subject && f.content === GRAIN_FACT)).toBe(
      true,
    );

    closeDatabase(db);

    const control = openDatabase(":memory:");
    applySchema(control);
    const home = path.join(tmp("om-coding-h-"), "cursor-home");
    plantCursor(home, "sess-coding-grain", GRAIN_FILE);
    pullSources(control, [{ kind: "cursor", home, cwd: PROJECT_CWD }]);
    const emptyK = await searchWithProvider(control, "bookings", null);
    expect(hitsNeedle(emptyK, "bookings")).toBe(false);
    expect(episodeMentions(emptyK, "bookings")).toBe(true);

    await consolidate(control, createHeuristicProvider(), {
      extraction: extractionConfig() as never,
    });
    const still = await searchWithProvider(control, "bookings", null);
    expect(hitsNeedle(still, "bookings")).toBe(false);
    closeDatabase(control);
  });

  it("keeps stg_orders and bookings as two entities; does not invent a mapping", async () => {
    const rec = recordingExtractor();
    const db = openDatabase(":memory:");
    applySchema(db);
    const home = path.join(tmp("om-coding-id-"), "cursor-home");
    plantCursor(home, "sess-coding-grain", GRAIN_FILE);
    plantCursor(home, "sess-coding-ident", IDENT_FILE);
    pullSources(db, [{ kind: "cursor", home, cwd: PROJECT_CWD }]);
    await consolidate(db, rec.provider as never, {
      extraction: extractionConfig() as never,
    });

    expect(hitsNeedle(await searchWithProvider(db, "bookings", null), "grain")).toBe(
      true,
    );
    expect(
      hitsNeedle(await searchWithProvider(db, "stg_orders", null), "booked_at"),
    ).toBe(true);

    const bookings = findEntity(db, "bookings");
    const staging = findEntity(db, "stg_orders");
    expect(bookings).not.toBeNull();
    expect(staging).not.toBeNull();
    expect(bookings!.id).not.toBe(staging!.id);

    const aboutStaging = lookupNamedSubject(db, "stg_orders");
    expect(aboutStaging.found).toBe(true);
    expect(
      aboutStaging.facts.some((f) => f.is_subject && f.content === IDENT_FACT),
    ).toBe(true);
    expect(
      aboutStaging.facts.some((f) => f.is_subject && f.content === GRAIN_FACT),
    ).toBe(false);

    const unified = db
      .prepare(`SELECT content FROM facts WHERE content LIKE ?`)
      .all("%stg_orders%bookings%") as Array<{ content: string }>;
    expect(unified).toEqual([]);

    closeDatabase(db);
  });

  it("does not graduate a failing-join task; episodes still show the raw log", async () => {
    const rec = recordingExtractor();
    const { db, done } = await pullCursorAndConsolidate(
      EPH_FILE,
      "sess-coding-eph",
      rec.provider,
    );
    expect(done.factsGraduated).toBe(0);

    const found = await searchWithProvider(db, "failing", null);
    expect(hitsNeedle(found, "failing")).toBe(false);
    expect(found.results).toEqual([]);
    expect(episodeMentions(found, "failing")).toBe(true);
    closeDatabase(db);
  });

  it("graduates grain when the assistant states it and the user assents", async () => {
    const rec = recordingExtractor();
    const { db, done } = await pullCursorAndConsolidate(
      ASSENT_FILE,
      "sess-coding-assent",
      rec.provider,
    );
    expect(done.factsGraduated).toBeGreaterThan(0);
    expect(contentsOf(await searchWithProvider(db, "bookings", null))).toContain(
      GRAIN_FACT,
    );
    closeDatabase(db);
  });

  it("does not mint an entity per table in a truncated tool dump; user prose still graduates", async () => {
    const rec = recordingExtractor();
    const db = openDatabase(":memory:");
    applySchema(db);
    const home = path.join(tmp("om-coding-dump-"), "claude-home");
    const dump = schemaDump();
    plantClaudeLines(home, "sess-coding-dump", [
      JSON.stringify({
        type: "user",
        sessionId: "sess-coding-dump",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Bookings are the grain of the orders mart at Acme.",
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: dump,
            },
          ],
        },
      }),
    ]);
    const pulled = pullSources(db, [
      { kind: "claude-code", home, cwd: PROJECT_CWD },
    ]);
    expect(pulled.events_inserted).toBeGreaterThanOrEqual(2);

    await consolidate(db, rec.provider as never, {
      extraction: extractionConfig() as never,
    });

    expect(contentsOf(await searchWithProvider(db, "bookings", null))).toContain(
      GRAIN_FACT,
    );
    const widgets = db
      .prepare(`SELECT name FROM entities WHERE name LIKE 'dim_widget_%'`)
      .all() as Array<{ name: string }>;
    expect(widgets).toEqual([]);
    closeDatabase(db);
  });
});

// ---------------------------------------------------------------------------
// Live CLI — skip unless required; fail-closed when required
// ---------------------------------------------------------------------------

describe.runIf(required)("the coding-store eval is required in this run", () => {
  it("has a live claude CLI to extract with", () => {
    expect(unavailable).toBeNull();
  });
});

describe.skipIf(!required || unavailable !== null)(
  !required
    ? "coding-store via the claude CLI — skipped unless npm run test:coding-store"
    : unavailable
      ? `coding-store via the claude CLI — SKIPPED: ${unavailable}`
      : "coding-store via the claude CLI",
  () => {
    function run(args: string[], extra: { timeout?: number } = {}) {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.OPENMEMORY_DATA;
      delete env.OPENMEMORY_SUBPROCESS;
      delete env.OPENMEMORY_STORAGE;
      env.OPENMEMORY_PROVIDER = "cli";
      return spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf-8",
        env: env as NodeJS.ProcessEnv,
        timeout: extra.timeout ?? 30_000,
      });
    }

    function initPullStore(kind: "cursor" | "claude-code"): {
      dir: string;
      home: string;
    } {
      const dir = tmp("om-coding-cli-");
      const init = run(["init", dir]);
      expect(init.status).toBe(0);
      const home = path.join(dir, kind === "cursor" ? "cursor-home" : "claude-home");
      const configPath = path.join(dir, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      config.sources = [{ kind, home, cwd: PROJECT_CWD }];
      config.consolidation = {
        ...config.consolidation,
        triggers: ["manual"],
        threshold: 100000,
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      return { dir, home };
    }

    it(
      "grain fixture → pull → consolidate → search hits bookings",
      () => {
        const { dir, home } = initPullStore("cursor");
        plantCursor(home, "sess-coding-grain", GRAIN_FILE);

        const pulled = run(["pull", "--data", dir]);
        expect(pulled.status).toBe(0);
        expect(JSON.parse(pulled.stdout).events_inserted).toBeGreaterThan(0);

        const before = run(["search", "bookings", "--json", "--data", dir]);
        expect(before.status).toBe(0);
        expect(hitsNeedle(JSON.parse(before.stdout), "bookings")).toBe(false);

        const consolidated = run(["consolidate", "--data", dir], {
          timeout: 180_000,
        });
        expect(consolidated.status).toBe(0);
        const result = JSON.parse(consolidated.stdout);
        expect(result.skipped).toBe(false);
        expect(result.factsGraduated).toBeGreaterThan(0);

        const after = run(["search", "bookings", "--json", "--data", dir]);
        expect(after.status).toBe(0);
        expect(hitsNeedle(JSON.parse(after.stdout), "bookings")).toBe(true);
        expect(hitsNeedle(JSON.parse(after.stdout), "grain")).toBe(true);

        const db = openDatabase(path.join(dir, "memory.db"));
        const about = lookupNamedSubject(db, "bookings");
        expect(about.found).toBe(true);
        expect(
          about.facts.some(
            (f) => f.is_subject && /grain/i.test(f.content) && /bookings/i.test(f.content),
          ),
        ).toBe(true);
        closeDatabase(db);
      },
      240_000,
    );

    it(
      "failing-join task does not graduate; episodes still hit the raw log",
      () => {
        const { dir, home } = initPullStore("cursor");
        plantCursor(home, "sess-coding-eph", EPH_FILE);

        expect(run(["pull", "--data", dir]).status).toBe(0);
        const consolidated = run(["consolidate", "--data", dir], {
          timeout: 180_000,
        });
        expect(consolidated.status).toBe(0);

        const after = run(["search", "failing", "--json", "--data", dir]);
        expect(after.status).toBe(0);
        const payload = JSON.parse(after.stdout) as {
          results: Array<{ fact?: { content?: string } }>;
          episodes: Array<{ events?: Array<{ content?: string | null }> }>;
        };
        expect(hitsNeedle(payload, "failing")).toBe(false);
        expect(episodeMentions(payload, "failing")).toBe(true);
      },
      240_000,
    );
  },
);
