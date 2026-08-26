/**
 * First fact from a pulled transcript, without capture_fact.
 *
 * The claim Quick Start makes: fixture JSONL → pull → consolidate → search
 * hits. Every other test either stubs extract, skips pull, or captures the
 * fact by hand — so a green suite could imply that wow without it running.
 *
 * Two layers, same shape as the semantic eval:
 *
 *   1. Hermetic pipeline (always in `npm test`). A recording extractor stands
 *      in for the LLM so the path is asserted even on machines with no
 *      `claude` CLI. Heuristic extract is the control that must miss — if
 *      search hit events directly, the recording path would pass for the
 *      wrong reason.
 *   2. Live CLI (opt-in). Unlike the semantic eval (Ollama is rare), the
 *      `claude` CLI is common on machines that develop this repo, so a
 *      skipIf-when-missing would still run a multi-minute model call inside
 *      `npm test`. The live path runs only when
 *      OPENMEMORY_REQUIRE_FIRST_FACT_EVAL=1 (`npm run test:first-fact`) and
 *      then *fails* when the CLI is missing rather than quietly verifying
 *      nothing.
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
import { consolidate } from "../../src/intelligence/consolidate.js";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
import { probeCliProvider } from "../../src/intelligence/cli.js";
import { pullSources } from "../../src/sources/pull.js";
import { encodeProjectDir } from "../../src/sources/resolve.js";
import { searchWithProvider } from "../../src/search/index.js";
import type { SessionEvent } from "../../src/types/data.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SERVER = path.join(ROOT, "dist", "index.js");
const CLI = path.join(ROOT, "dist", "cli", "index.js");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "first-fact.jsonl");

const QUERY = "kaleidoscope";
const FACT = "Alex keeps a brass kaleidoscope on the desk at Acme.";
const PROJECT_CWD = "C:\\dev\\app";

const required = process.env.OPENMEMORY_REQUIRE_FIRST_FACT_EVAL === "1";

function probeLiveCli(): string | null {
  if (!existsSync(SERVER) || !existsSync(CLI)) return "dist/ is not built";
  if (!existsSync(FIXTURE)) return "first-fact fixture is missing";
  const probe = probeCliProvider();
  if (!probe.available) {
    return `claude CLI not available (${probe.command.join(" ")} --version failed)`;
  }
  return null;
}

// Do not spawn `--version` on every `npm test`. The live path is opt-in.
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

function plantTranscript(home: string): void {
  const file = path.join(
    home,
    "projects",
    encodeProjectDir(PROJECT_CWD),
    "sess-first-fact.jsonl",
  );
  mkdirSync(path.dirname(file), { recursive: true });
  copyFileSync(FIXTURE, file);
}

function contentsOf(response: {
  results?: Array<{ fact?: { content?: string } }>;
}): string[] {
  return (response.results ?? []).map((r) => r.fact?.content ?? "");
}

function hitsKaleidoscope(response: {
  results?: Array<{ fact?: { content?: string } }>;
}): boolean {
  return contentsOf(response).some((c) => c.toLowerCase().includes(QUERY));
}

// ---------------------------------------------------------------------------
// Hermetic pipeline — always runs
// ---------------------------------------------------------------------------

describe("first-fact pipeline (recording extractor)", () => {
  it("pulls a fixture, extracts, and search hits; heuristic extract does not", async () => {
    expect(existsSync(FIXTURE)).toBe(true);

    const db = openDatabase(":memory:");
    applySchema(db);
    const home = path.join(tmp("om-first-fact-"), "claude-home");
    plantTranscript(home);

    const pulled = pullSources(db, [
      { kind: "claude-code", home, cwd: PROJECT_CWD },
    ]);
    expect(pulled.events_inserted).toBeGreaterThan(0);

    const empty = await searchWithProvider(db, QUERY, null);
    // Events are not knowledge. If `results` hits, search is mixing D into K
    // and the rest of the suite would pass without extract ever running.
    expect(hitsKaleidoscope(empty)).toBe(false);
    expect(
      empty.episodes.some((s) =>
        s.events.some(
          (e) => e.matched && (e.content ?? "").toLowerCase().includes(QUERY),
        ),
      ),
    ).toBe(true);

    const heuristic = createHeuristicProvider();
    let extractCalls = 0;
    const recording = {
      ...heuristic,
      async extractFactsFromEvents(events: SessionEvent[]) {
        extractCalls += 1;
        const hit = events.find(
          (e) =>
            e.role === "user" &&
            (e.content ?? "").toLowerCase().includes(QUERY),
        );
        return {
          facts: hit
            ? [{ content: FACT, domain_hint: null as string | null }]
            : [],
          degraded: false,
        };
      },
    };

    const done = await consolidate(db, recording as never, {
      extraction: { enabled: true } as never,
    });
    expect(extractCalls).toBeGreaterThan(0);
    expect(done.skipped).toBe(false);
    expect(done.factsGraduated).toBeGreaterThan(0);

    const found = await searchWithProvider(db, QUERY, null);
    expect(hitsKaleidoscope(found)).toBe(true);
    expect(contentsOf(found)).toContain(FACT);
    // K is no longer thin — D stays off the response.
    expect(found.episodes).toEqual([]);

    closeDatabase(db);
  });

  it("heuristic extract does not mint a searchable fact from the same fixture", async () => {
    const db = openDatabase(":memory:");
    applySchema(db);
    const home = path.join(tmp("om-first-fact-h-"), "claude-home");
    plantTranscript(home);

    pullSources(db, [{ kind: "claude-code", home, cwd: PROJECT_CWD }]);
    await consolidate(db, createHeuristicProvider(), {
      extraction: { enabled: true } as never,
    });
    const found = await searchWithProvider(db, QUERY, null);
    expect(hitsKaleidoscope(found)).toBe(false);
    closeDatabase(db);
  });
});

// ---------------------------------------------------------------------------
// Live CLI — skip unless required; fail-closed when required
// ---------------------------------------------------------------------------

describe.runIf(required)("the first-fact eval is required in this run", () => {
  it("has a live claude CLI to extract with", () => {
    expect(unavailable).toBeNull();
  });
});

describe.skipIf(!required || unavailable !== null)(
  !required
    ? "first-fact via the claude CLI — skipped unless npm run test:first-fact"
    : unavailable
      ? `first-fact via the claude CLI — SKIPPED: ${unavailable}`
      : "first-fact via the claude CLI",
  () => {
    function run(
      args: string[],
      extra: { timeout?: number } = {},
    ) {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.OPENMEMORY_DATA;
      delete env.OPENMEMORY_SUBPROCESS;
      delete env.OPENMEMORY_STORAGE;
      // The README path uses the configured provider (cli). A developer who
      // has OPENMEMORY_PROVIDER=heuristic in the shell must not silently
      // convert this eval into the control that is supposed to miss.
      env.OPENMEMORY_PROVIDER = "cli";
      return spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf-8",
        env: env as NodeJS.ProcessEnv,
        timeout: extra.timeout ?? 30_000,
      });
    }

    it(
      "fixture JSONL → pull → consolidate → search hits",
      () => {
        const dir = tmp("om-first-fact-cli-");
        const init = run(["init", dir]);
        expect(init.status).toBe(0);

        const home = path.join(dir, "claude-home");
        plantTranscript(home);

        const configPath = path.join(dir, "config.json");
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        config.sources = [{ kind: "claude-code", home, cwd: PROJECT_CWD }];
        // Manual only: the eval is the consolidate invocation, not a
        // session_start race against the CLI process.
        config.consolidation = {
          ...config.consolidation,
          triggers: ["manual"],
          threshold: 100000,
        };
        writeFileSync(configPath, JSON.stringify(config, null, 2));

        const pulled = run(["pull", "--data", dir]);
        expect(pulled.status).toBe(0);
        const pullJson = JSON.parse(pulled.stdout);
        expect(pullJson.events_inserted).toBeGreaterThan(0);

        const before = run(["search", QUERY, "--json", "--data", dir]);
        expect(before.status).toBe(0);
        expect(hitsKaleidoscope(JSON.parse(before.stdout))).toBe(false);

        const consolidated = run(["consolidate", "--data", dir], {
          timeout: 180_000,
        });
        expect(consolidated.status).toBe(0);
        const result = JSON.parse(consolidated.stdout);
        expect(result.skipped).toBe(false);
        expect(result.factsGraduated).toBeGreaterThan(0);

        const after = run(["search", QUERY, "--json", "--data", dir]);
        expect(after.status).toBe(0);
        expect(hitsKaleidoscope(JSON.parse(after.stdout))).toBe(true);
      },
      240_000,
    );
  },
);
