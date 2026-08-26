/**
 * CLI entry-point integration tests.
 *
 * `src/cli/index.ts` runs main() on import, so its dispatch, recursion guard,
 * argument precedence, and exit codes are unreachable from unit tests — the
 * only way to exercise them is to spawn the built CLI as a real subprocess.
 * Both bugs found in this area (a silently no-opping `init`, an unparseable
 * MCP snippet) were invisible to unit tests and only appeared when run.
 *
 * Requires a build: CI runs `build` before `test`. Skips when dist is absent
 * rather than failing with a confusing module-not-found.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(
  fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)),
);
const SERVER = path.resolve(
  fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
);


// The CLI must be built to spawn it; sqlite itself is built into Node.
const runnable = existsSync(CLI);

/**
 * Run the built CLI. OPENMEMORY_* vars are stripped from the inherited
 * environment so a developer's own settings can't influence assertions —
 * every test states the environment it means to test.
 */
function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.OPENMEMORY_DATA;
  delete env.OPENMEMORY_SUBPROCESS;
  delete env.OPENMEMORY_STORAGE;
  // Default to the provider that costs nothing to report on. `init` probes for
  // the claude CLI when `cli` is selected, and that probe spawns subprocesses —
  // seconds per run, on a machine that may or may not have the CLI installed.
  // Tests that care about the probe set this themselves; the branches it picks
  // between are unit-tested in tests/cli/init.test.ts.
  env.OPENMEMORY_PROVIDER = "heuristic";
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: env as NodeJS.ProcessEnv,
    timeout: 30_000,
  });
}

let root: string;

beforeEach(() => {
  if (!runnable) return;
  root = mkdtempSync(path.join(tmpdir(), "om-cli-"));
});

afterEach(() => {
  if (!runnable) return;
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!runnable)("cli entry — dispatch and usage", () => {
  it("prints usage listing every command and exits non-zero with no subcommand", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    for (const cmd of ["init", "log-event", "signal", "consolidate", "pull"]) {
      expect(r.stderr).toContain(cmd);
    }
  });

  it("exits non-zero on an unknown subcommand", () => {
    const r = run(["bogus-command"]);
    expect(r.status).toBe(1);
  });
});

describe.skipIf(!runnable)("cli entry — init argument precedence", () => {
  it("accepts a positional directory", () => {
    const dir = path.join(root, "positional");
    const r = run(["init", dir]);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
  });

  it("accepts --data", () => {
    const dir = path.join(root, "flag");
    const r = run(["init", "--data", dir]);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
  });

  it("falls back to OPENMEMORY_DATA when no directory is given", () => {
    const dir = path.join(root, "fromenv");
    const r = run(["init"], { OPENMEMORY_DATA: dir });
    expect(r.status).toBe(0);
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
  });

  it("prefers the positional directory over --data and the env var", () => {
    const wanted = path.join(root, "wanted");
    const ignored = path.join(root, "ignored");
    const alsoIgnored = path.join(root, "also-ignored");
    const r = run(["init", wanted, "--data", ignored], {
      OPENMEMORY_DATA: alsoIgnored,
    });
    expect(r.status).toBe(0);
    expect(existsSync(path.join(wanted, "config.json"))).toBe(true);
    expect(existsSync(ignored)).toBe(false);
    expect(existsSync(alsoIgnored)).toBe(false);
  });

  it("exits non-zero with a diagnostic when the target can't be created", () => {
    const target = path.join(root, "afile");
    writeFileSync(target, "not a directory", "utf-8");
    const r = run(["init", target]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Failed to initialise/i);
  });

  it("refuses postgres instead of creating a sqlite file", () => {
    const dir = path.join(root, "pg-init");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    const r = run(["init", dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(`Failed to initialise ${path.resolve(dir)}:`);
    expect(r.stderr).toMatch(/postgres/);
    expect(r.stderr).toMatch(/SQLite was not opened/);
    expect(existsSync(path.join(dir, "memory.db"))).toBe(false);
  });

  it("refuses OPENMEMORY_STORAGE=postgres even when config says sqlite", () => {
    const dir = path.join(root, "pg-env");
    const init = run(["init", dir]);
    expect(init.status).toBe(0);
    expect(existsSync(path.join(dir, "memory.db"))).toBe(true);
    const r = run(["search", "bookings", "--data", dir], {
      OPENMEMORY_STORAGE: "postgres",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/postgres/);
    expect(r.stderr).toMatch(/SQLite was not opened/);
  });

  it("MCP server refuses postgres before creating memory.db", () => {
    const dir = path.join(root, "pg-server");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ storage: { provider: "postgres" } }),
    );
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.OPENMEMORY_DATA;
    delete env.OPENMEMORY_SUBPROCESS;
    delete env.OPENMEMORY_STORAGE;
    env.OPENMEMORY_PROVIDER = "heuristic";
    const r = spawnSync(process.execPath, [SERVER, "--data", dir], {
      encoding: "utf-8",
      env: env as NodeJS.ProcessEnv,
      timeout: 8_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/postgres/);
    expect(r.stderr).toMatch(/SQLite was not opened/);
    expect(existsSync(path.join(dir, "memory.db"))).toBe(false);
  });
});

describe.skipIf(!runnable)("cli entry — init reports the intelligence it will get", () => {
  // The unit tests cover which message each branch produces. This covers the
  // wiring: that init really probes, and that the warning reaches stdout rather
  // than being composed and dropped.
  it("warns end to end when the configured CLI cannot be run", () => {
    const dir = path.join(root, "no-cli");
    // A path that cannot be spawned. Resolution short-circuits on this env var,
    // so the probe fails immediately instead of hunting the filesystem.
    const r = run(["init", dir], {
      OPENMEMORY_PROVIDER: "cli",
      CLAUDE_CLI_PATH: path.join(root, "definitely-not-installed"),
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARNING/);
    expect(r.stdout).toMatch(/no domain routing/);
  });

  it("says which provider is in play when it is not the CLI one", () => {
    const dir = path.join(root, "heuristic");
    const r = run(["init", dir]);

    expect(r.stdout).toMatch(/Consolidation intelligence: heuristic/);
    expect(r.stdout).not.toMatch(/WARNING/);
  });
});

describe.skipIf(!runnable)("cli entry — init output", () => {
  it("says one data directory is one memory", () => {
    const dir = path.join(root, "one-brain");
    const r = run(["init", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/one data directory is one memory/i);
    expect(r.stdout).toMatch(/second brain is a second directory/i);
  });

  it("tells a tester that pull is off until they name a source", () => {
    const dir = path.join(root, "sources-hint");
    const r = run(["init", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/pull is off/i);
    expect(r.stdout).toMatch(/claude-code/);
    expect(r.stdout).toMatch(/openmemory pull/);
  });

  it("prints an MCP snippet that parses as JSON, with the data dir escaped", async () => {
    const dir = path.join(root, "snippet");
    const r = run(["init", dir]);
    expect(r.status).toBe(0);

    // Extract the MCP snippet only — later status lines must not be swallowed
    // into this parse (a second JSON object in the output used to break it).
    const match = r.stdout.match(/\{\s*"mcpServers"[\s\S]*?\n  \}/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![0]); // throws if the path wasn't escaped
    const { mcpServerName } = await import("../../src/cli/init.js");
    const key = mcpServerName(path.resolve(dir));
    const entry = parsed.mcpServers[key];
    expect(entry).toBeDefined();
    expect(entry.command).toBe("npx");
    expect(entry.env.OPENMEMORY_DATA).toBe(path.resolve(dir));
    expect(parsed.mcpServers.openmemory).toBeUndefined();
  });

  it("reports the config as preserved on re-run and reset with --force", () => {
    const dir = path.join(root, "rerun");
    run(["init", dir]);

    const configPath = path.join(dir, "config.json");
    const edited = JSON.parse(readFileSync(configPath, "utf-8"));
    edited.consolidation.threshold = 99;
    writeFileSync(configPath, JSON.stringify(edited, null, 2), "utf-8");

    const second = run(["init", dir]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already exists/i);
    // The user's edit survived.
    expect(JSON.parse(readFileSync(configPath, "utf-8")).consolidation.threshold).toBe(99);

    const forced = run(["init", dir, "--force"]);
    expect(forced.status).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).consolidation.threshold).toBe(10);
  });
});

describe.skipIf(!runnable)("cli entry — subprocess recursion guard", () => {
  it("runs init normally under OPENMEMORY_SUBPROCESS=1 (it cannot recurse)", () => {
    // Regression: the guard used to exit before dispatch, so init exited 0
    // having created nothing — an explicit setup command silently no-opping.
    const dir = path.join(root, "guarded-init");
    const r = run(["init", dir], { OPENMEMORY_SUBPROCESS: "1" });
    expect(r.status).toBe(0);
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
    expect(existsSync(path.join(dir, "memory.db"))).toBe(true);
  });

  it("skips log-event under OPENMEMORY_SUBPROCESS=1 without writing anything", () => {
    const dir = path.join(root, "guarded-log");
    const r = run(
      ["log-event", "--role", "user", "--content", "synthetic", "--data", dir],
      { OPENMEMORY_SUBPROCESS: "1" },
    );
    expect(r.status).toBe(0);
    expect(existsSync(path.join(dir, "memory.db"))).toBe(false);
  });

  it("skips consolidate under OPENMEMORY_SUBPROCESS=1", () => {
    const dir = path.join(root, "guarded-consolidate");
    run(["init", dir]);
    const r = run(["consolidate", "--data", dir], { OPENMEMORY_SUBPROCESS: "1" });
    expect(r.status).toBe(0);
    // The guard exits before any consolidation result is printed.
    expect(r.stdout.trim()).toBe("");
  });

  it("logs an event normally when the guard is not set", () => {
    // Control case for the guard tests above: proves they skip because of the
    // env var, not because log-event is broken.
    const dir = path.join(root, "unguarded");
    run(["init", dir]);

    const r = run([
      "log-event", "--role", "user", "--event-type", "message",
      "--content", "synthetic event", "--data", dir,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/event_id/);
    expect(existsSync(path.join(dir, "memory.db"))).toBe(true);
  });

  it("creates the data dir when logging to one that doesn't exist yet", () => {
    // Hooks can fire before the server has ever run for a data dir. Requiring
    // the dir to pre-exist dropped the event, with the error going to a hook's
    // stderr where nobody sees it.
    const dir = path.join(root, "never-initialised");
    const r = run([
      "log-event", "--role", "user", "--event-type", "message",
      "--content", "synthetic", "--data", dir,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/event_id/);
    expect(existsSync(path.join(dir, "memory.db"))).toBe(true);
  });
});

describe.skipIf(!runnable)("cli entry — search and stats", () => {
  /** Seed synthetic facts into an initialised data dir. */
  async function seed(dir: string) {
    run(["init", dir]);
    const { openDatabase, closeDatabase } = await import(
      "../../src/db/connection.js"
    );
    const { insertFact } = await import("../../src/db/facts.js");
    const { createSource } = await import("../../src/db/sources.js");
    const { ensureDomain } = await import("../../src/db/domains.js");

    const db = openDatabase(path.join(dir, "memory.db"));
    const source = await createSource(db, {
      type: "test",
      tool_id: null,
      raw_content: "x",
      metadata: {},
    });
    const add = async (content: string, domain: string) => {
      await ensureDomain(db, domain);
      await insertFact(db, {
        content,
        domain,
        subdomain: null,
        confidence: 0.9,
        importance: 0.5,
        source_type: "conversation",
        source_tool: null,
        source_id: source.id,
        session_id: null,
        capture_context: null,
        source_quality: "explicit",
      });
    };
    await add("Prefers dark roast coffee", "preferences");
    await add("Dislikes instant coffee", "preferences");
    await add("Drinks coffee at the Acme office", "work");
    await closeDatabase(db);
  }

  it("stats reports what the store holds", async () => {
    const dir = path.join(root, "stats");
    await seed(dir);

    const r = run(["stats", "--data", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("3 current");
    expect(r.stdout).toContain("preferences");
  });

  it("stats --json emits parseable JSON on stdout", async () => {
    const dir = path.join(root, "stats-json");
    await seed(dir);

    const r = run(["stats", "--json", "--data", dir]);
    expect(r.status).toBe(0);
    // Nothing may pollute stdout — the experimental-SQLite warning Node emits
    // on load goes to stderr, and this asserts it stays there.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.facts.active_latest).toBe(3);
  });

  it("search finds a matching fact", async () => {
    const dir = path.join(root, "search");
    await seed(dir);

    const r = run(["search", "coffee", "--data", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dark roast");
  });

  it("search --json emits parseable JSON on stdout", async () => {
    const dir = path.join(root, "search-json");
    await seed(dir);

    const r = run(["search", "coffee", "--json", "--data", dir]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it("search --domain ranks that domain first without hiding the rest", async () => {
    // --domain biases ranking; it does not filter. A domain label is chosen by a
    // classifier and is approximate, so filtering on one would hide a fact filed
    // under a near-synonym and show an empty result instead.
    const dir = path.join(root, "search-domain");
    await seed(dir);

    const r = run(["search", "coffee", "--domain", "work", "--json", "--data", dir]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);

    // The work fact matches the query and sits in the named domain, so it
    // reaches the merge by two paths and ranks first.
    expect(parsed.results[0].fact.domain).toBe("work");
    // The preferences facts also match "coffee" and must still be reachable.
    expect(parsed.results.map((x: any) => x.fact.domain)).toContain("preferences");
  });

  it("search --limit caps the result count", async () => {
    const dir = path.join(root, "search-limit");
    await seed(dir);

    const r = run(["search", "coffee", "--limit", "1", "--json", "--data", dir]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).results).toHaveLength(1);
  });

  it("search reports an empty store plainly instead of failing", async () => {
    const dir = path.join(root, "empty");
    run(["init", dir]);

    const r = run(["search", "coffee", "--data", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No knowledge found");
  });

  it("search without a query exits non-zero", () => {
    const dir = path.join(root, "no-query");
    run(["init", dir]);

    const r = run(["search", "--data", dir]);
    expect(r.status).toBe(1);
  });

  it("search --as-of-system on a simple store exits non-zero", () => {
    const dir = path.join(root, "as-of-simple");
    run(["init", dir]);
    const r = run([
      "search",
      "coffee",
      "--as-of-system",
      "2026-01-01T00:00:00Z",
      "--data",
      dir,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bitemporal/);
  });

  it("search --as-of-system on a bitemporal store returns the fact believed then", async () => {
    const dir = path.join(root, "as-of-bi");
    run(["init", dir]);
    const configPath = path.join(dir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.temporal = { mode: "bitemporal", bitemporal_since: "2000-01-01T00:00:00.000Z" };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const { openDatabase, closeDatabase } = await import(
      "../../src/db/connection.js"
    );
    const { insertFact, supersedeFact } = await import("../../src/db/facts.js");
    const db = openDatabase(path.join(dir, "memory.db"));
    const old = await insertFact(db, {
      content: "Prefers tea",
      domain: "preferences",
      source_type: "conversation",
    });
    while (new Date().toISOString() <= old.created_at) {
      /* millisecond clock */
    }
    await supersedeFact(
      db,
      old.id,
      {
        content: "Prefers coffee",
        domain: "preferences",
        source_type: "conversation",
      },
      { retireSystemTime: true },
    );
    await closeDatabase(db);

    const now = run(["search", "Prefers", "--json", "--data", dir]);
    expect(now.status).toBe(0);
    const nowBody = JSON.parse(now.stdout);
    expect(nowBody.results.map((r: { fact: { content: string } }) => r.fact.content)).toEqual(
      ["Prefers coffee"],
    );

    const then = run([
      "search",
      "Prefers",
      "--as-of-system",
      old.created_at,
      "--json",
      "--data",
      dir,
    ]);
    expect(then.status).toBe(0);
    const thenBody = JSON.parse(then.stdout);
    expect(thenBody.results.map((r: { fact: { content: string } }) => r.fact.content)).toEqual(
      ["Prefers tea"],
    );
  });

  it.each(["search", "stats", "pull"])(
    "%s points at init rather than leaking a raw SQLite error when there is no database",
    (cmd) => {
      const dir = path.join(root, "uninitialised");
      const r = run(cmd === "search" ? [cmd, "coffee", "--data", dir] : [cmd, "--data", dir]);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("No database at");
      expect(r.stderr).toContain("openmemory init");
      expect(r.stderr).not.toMatch(/SQLITE_|unable to open database/i);
    },
  );
});

describe.skipIf(!runnable)("cli entry — pull", () => {
  it("is a no-op when sources is empty", () => {
    const dir = path.join(root, "pull-empty");
    run(["init", dir]);
    const r = run(["pull", "--data", dir]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.sources).toBe(0);
    expect(parsed.events_inserted).toBe(0);
  });

  it("ingests a fixture transcript without capture_fact", () => {
    const dir = path.join(root, "pull-fixture");
    run(["init", dir]);

    const home = path.join(root, "claude-home");
    const file = path.join(home, "projects", "C--dev-app", "sess-cli.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        sessionId: "sess-cli",
        message: { role: "user", content: "The demo store prefers dark mode." },
      }) + "\n",
      "utf-8",
    );

    const configPath = path.join(dir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.sources = [{ kind: "claude-code", home, cwd: "C:\\dev\\app" }];
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const r = run(["pull", "--data", dir]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).events_inserted).toBe(1);
    // No MCP server in this process — a small pull must not look successful
    // and then leave search empty. Tick is attempted; when it cannot land,
    // the CLI names the next command.
    expect(r.stderr).toMatch(/openmemory consolidate/);
    expect(r.stderr).not.toMatch(/skipping auto-consolidate/);

    const again = run(["pull", "--data", dir]);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout).events_inserted).toBe(0);
  });

  it("exits non-zero on an unknown source kind", () => {
    const dir = path.join(root, "pull-unknown");
    run(["init", dir]);
    const configPath = path.join(dir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.sources = [{ kind: "grok", home: path.join(root, "nope") }];
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const r = run(["pull", "--data", dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown source kind "grok"/);
  });
});

describe.skipIf(!runnable)("prune", () => {
  /**
   * The safety property, asserted against the real binary: the command that
   * deletes data must not delete data unless asked. A default that applied
   * would be irreversible, and the only place the default lives is argument
   * parsing — which unit tests of the query layer never reach.
   */
  it("is listed as a command", () => {
    const r = run([]);
    expect(r.stderr).toContain("prune");
  });

  it("reports without deleting by default", () => {
    run(["init", root]);
    const r = run(["prune", "--data", root, "--json"]);
    expect(r.status).toBe(0);

    const out = JSON.parse(r.stdout);
    expect(out.applied).toBe(false);
    // A fresh store has no consolidations, so the watermark is 0 and nothing
    // has been read yet — the correct answer is zero, and it must be reached
    // by the rule rather than by the command failing.
    expect(out.events).toBe(0);
  });

  it("explains the rule when there is nothing to reclaim", () => {
    // A bare "0 events" reads as broken. On a fresh store the answer is zero
    // because nothing has been extracted yet, and saying so is the difference
    // between a working command and an apparently useless one.
    run(["init", root]);
    const r = run(["prune", "--data", root]);
    expect(r.stdout).toContain("dry run");
    expect(r.stdout).toContain("Nothing to reclaim");
    expect(r.stdout).toContain("provenance");
    // Nothing to apply, so it must not advertise the destructive flag here.
    expect(r.stdout).not.toContain("--apply");
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    // strict parsing: `--force` silently doing nothing on a delete command is
    // exactly the misunderstanding that costs data.
    run(["init", root]);
    const r = run(["prune", "--data", root, "--force"]);
    expect(r.status).not.toBe(0);
  });
});
