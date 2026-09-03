/**
 * Cross-tool integration — the claim the whole product rests on: two AI tools
 * sharing knowledge through the MCP server alone, with no client-side rules.
 *
 * Every other test drives the internals in-process. This one spawns the built
 * server twice over stdio, as Claude Code and Claude Desktop each would, and
 * points both at ONE data directory: one SQLite file, two connections, two
 * schedulers, one advisory consolidation lock. That combination is unreachable
 * from in-process tests, and it is exactly where a reliability bug would hide —
 * a stranded fact or a double-integration shows up here and nowhere else.
 *
 * Requires a build: CI runs `build` before `test`. Skips when dist is absent
 * rather than failing with a confusing module-not-found.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutStoreEnv } from "../helpers/cli-env.js";

const SERVER = path.resolve(
  fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
);
const CLI = path.resolve(
  fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)),
);

const runnable = existsSync(SERVER) && existsSync(CLI);

let root: string;
let clients: Client[] = [];

/** Spawn the built server as a separate process and connect a client to it. */
async function connect(name: string, dataDir: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.FACTHOUSE_DATA = dataDir;
  // Heuristic keeps the test hermetic: the default provider shells out to the
  // `claude` CLI, which would make this depend on a subscription and a network.
  env.FACTHOUSE_PROVIDER = "heuristic";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const text = (r: any) => r.content?.[0]?.text ?? "";

/**
 * Call a tool and fail loudly if it reports an error.
 *
 * The MCP tools signal failure with `isError: true` and an error payload in the
 * content, rather than rejecting. A test that ignores that reads the failure as
 * a normal result and sails on: a capture returning {"error":"database is
 * locked"} looked like success here, and the test only failed three assertions
 * later on an empty search — pointing at retrieval for a bug in the write path.
 */
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  if (r.isError) {
    throw new Error(`${name} failed: ${text(r)}`);
  }
  return r;
};
const json = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(text(await call(c, name, args)));

/**
 * Consolidate and prove it actually did the work.
 *
 * The server runs its own scheduler, so an automatic run can hold the advisory
 * lock while an explicit call arrives — the explicit run then skips, and a test
 * that reads the results immediately sees an empty store and fails for reasons
 * having nothing to do with what it was testing. Tolerating a skipped run is how
 * these tests became intermittently flaky under parallel load.
 */
async function consolidateForReal(client: Client) {
  const result = await json(client, "consolidate", {});
  if (result.skipped) {
    // The scheduler beat us to the lock. Its run integrates the same facts, so
    // retry rather than fail — but never proceed on the assumption it happened.
    const retry = await json(client, "consolidate", {});
    expect(retry.skipped).toBe(false);
    return retry;
  }
  return result;
}

/** Turn off automatic consolidation so explicit calls genuinely contend. */
function manualConsolidationOnly(dataDir: string) {
  const p = path.join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(p, "utf-8"));
  config.consolidation.triggers = ["manual"];
  config.consolidation.threshold = 100000;
  writeFileSync(p, JSON.stringify(config, null, 2));
}

beforeEach(() => {
  if (!runnable) return;
  root = mkdtempSync(path.join(tmpdir(), "om-xtool-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(withoutStoreEnv())) {
    if (v !== undefined) env[k] = v;
  }
  env.FACTHOUSE_PROVIDER = "heuristic";
  env.FACTHOUSE_PROVIDER = "heuristic";
  spawnSync(process.execPath, [CLI, "init", root, "--yes"], {
    encoding: "utf-8",
    timeout: 30_000,
    env,
  });

  // Every test here consolidates explicitly. Leaving the server's own scheduler
  // running means an automatic run can hold the advisory lock when an explicit
  // call arrives — the explicit run skips, the test reads an empty store, and it
  // fails for reasons unrelated to cross-tool sharing. That made this file
  // intermittently flaky under parallel load while passing in isolation, which
  // is the worst way for a test to be wrong.
  //
  // The scheduler is covered by its own tests; nothing here is testing it.
  manualConsolidationOnly(root);
}, 30_000);

afterEach(async () => {
  if (!runnable) return;
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  clients = [];
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!runnable)("cross-tool knowledge sharing", () => {
  it(
    "a fact captured in one tool is searchable from another",
    async () => {
      const toolA = await connect("tool-a", root);
      const toolB = await connect("tool-b", root);

      await call(toolA, "capture_fact", { content: "Alex prefers dark roast coffee" });
      await consolidateForReal(toolA);

      // Tool B never saw the capture and has no client-side rules — the server
      // is the only thing connecting them.
      const found = await json(toolB, "search_knowledge", { query: "coffee" });
      expect(found.results.length).toBeGreaterThan(0);
      expect(found.results.map((r: any) => r.fact.content).join(" ")).toContain(
        "dark roast",
      );
    },
    60_000,
  );

  it(
    "the resources one tool exposes reflect another tool's captures",
    async () => {
      const toolA = await connect("tool-a", root);
      const toolB = await connect("tool-b", root);

      // domain_hint pins the routing so this tests what it claims to — whether
      // one tool's resource reflects another tool's capture. Without it the
      // assertion would also depend on the classifier, and a routing change
      // would fail this test for reasons that have nothing to do with
      // cross-tool visibility.
      await call(toolA, "capture_fact", {
        content: "The user is called Alex Rivera",
        domain_hint: "profile",
      });
      await consolidateForReal(toolA);

      const profile = await toolB.readResource({ uri: "memory://profile" });
      expect(String(profile.contents[0].text)).toContain("Alex Rivera");
    },
    60_000,
  );

  it(
    "concurrent captures from two tools all survive",
    async () => {
      const toolA = await connect("tool-a", root);
      const toolB = await connect("tool-b", root);

      // Both tools write to one SQLite file at once. WAL plus the busy timeout
      // should absorb this; a regression here surfaces as SQLITE_BUSY.
      const writes = [];
      for (let i = 0; i < 10; i++) {
        writes.push(call(toolA, "capture_fact", { content: `Alpha synthetic fact ${i}` }));
        writes.push(call(toolB, "capture_fact", { content: `Beta synthetic fact ${i}` }));
      }
      const settled = await Promise.allSettled(writes);

      expect(settled.filter((s) => s.status === "rejected")).toEqual([]);
    },
    60_000,
  );

  it(
    "two tools consolidating at once neither strand nor duplicate facts",
    async () => {
      const toolA = await connect("tool-a", root);
      const toolB = await connect("tool-b", root);

      for (let i = 0; i < 8; i++) {
        await call(toolA, "capture_fact", { content: `Alpha synthetic fact ${i}` });
        await call(toolB, "capture_fact", { content: `Beta synthetic fact ${i}` });
      }
      expect((await json(toolA, "get_stats")).facts.total).toBe(0); // nothing auto-ran

      const [ra, rb] = await Promise.allSettled([
        call(toolA, "consolidate", {}),
        call(toolB, "consolidate", {}),
      ]);
      expect(ra.status).toBe("fulfilled");
      expect(rb.status).toBe("fulfilled");

      // Every captured fact integrates exactly once. The advisory lock serialises
      // the two runs: whichever wins takes the whole pending batch — including
      // the other session's facts — and the loser finds nothing left to do.
      // Under-counting means facts were stranded; over-counting means the batch
      // was processed twice.
      const stats = await json(toolA, "get_stats");
      expect(stats.facts.total).toBe(16);
      expect(stats.facts.active_latest).toBe(16);
    },
    90_000,
  );

  it(
    "a fact captured in one tool is consolidated by the other",
    async () => {
      // Tool A captures and then goes away without consolidating — a client
      // closing mid-session. Its facts must not be orphaned: the next tool to
      // consolidate picks up the whole pending batch, not just its own session.
      const toolA = await connect("tool-a", root);
      await call(toolA, "capture_fact", { content: "Alex prefers dark roast coffee" });
      await toolA.close();

      const toolB = await connect("tool-b", root);
      const run = await json(toolB, "consolidate", {});
      expect(run.facts_in).toBeGreaterThan(0);

      const found = await json(toolB, "search_knowledge", { query: "coffee" });
      expect(found.results.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
