/**
 * CLI entry-point integration tests.
 *
 * `src/cli/index.ts` runs main() on import, so its dispatch, recursion guard,
 * argument precedence, and exit codes are unreachable from unit tests — the
 * only way to exercise them is to spawn the built CLI as a real subprocess.
 * Both bugs found in this area (a silently no-opping `init`, an unparseable
 * MCP snippet) were invisible to unit tests and only appeared when run.
 *
 * Requires a build: CI runs `build` before `test`. When dist is absent the
 * suite skips rather than failing with a confusing module-not-found.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(
  fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)),
);
const built = existsSync(CLI);

/**
 * Run the built CLI. OPENMEMORY_* vars are stripped from the inherited
 * environment so a developer's own settings can't influence assertions —
 * every test states the environment it means to test.
 */
function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.OPENMEMORY_DATA;
  delete env.OPENMEMORY_SUBPROCESS;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: env as NodeJS.ProcessEnv,
  });
}

let root: string;

beforeEach(() => {
  if (!built) return;
  root = mkdtempSync(path.join(tmpdir(), "om-cli-"));
});

afterEach(() => {
  if (!built) return;
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!built)("cli entry — dispatch and usage", () => {
  it("prints usage listing every command and exits non-zero with no subcommand", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    for (const cmd of ["init", "log-event", "signal", "consolidate"]) {
      expect(r.stderr).toContain(cmd);
    }
  });

  it("exits non-zero on an unknown subcommand", () => {
    const r = run(["bogus-command"]);
    expect(r.status).toBe(1);
  });
});

describe.skipIf(!built)("cli entry — init argument precedence", () => {
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
});

describe.skipIf(!built)("cli entry — init output", () => {
  it("prints an MCP snippet that parses as JSON, with the data dir escaped", () => {
    const dir = path.join(root, "snippet");
    const r = run(["init", dir]);
    expect(r.status).toBe(0);

    // Extract the JSON block from the human-readable output.
    const match = r.stdout.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![0]); // throws if the path wasn't escaped
    const entry = parsed.mcpServers.openmemory;
    expect(entry.command).toBe("npx");
    expect(entry.env.OPENMEMORY_DATA).toBe(path.resolve(dir));
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

describe.skipIf(!built)("cli entry — subprocess recursion guard", () => {
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
    // env var, not because log-event is broken. The dir is initialised first —
    // log-event opens an existing database and does not create the data dir
    // (the server or `init` does that).
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

  it("fails loudly when log-event targets an uninitialised data dir", () => {
    // Documents current behaviour: the data dir must exist (created by the
    // server on boot, or by `init`). It errors with a clear message and a
    // non-zero exit rather than silently dropping the event.
    const r = run([
      "log-event", "--role", "user", "--content", "synthetic", "--data",
      path.join(root, "never-initialised"),
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/directory does not exist/i);
  });
});
