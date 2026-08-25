/**
 * Two data directories are two brains.
 *
 * Cross-tool tests prove two MCP clients on ONE directory share knowledge.
 * That is the product claim for a single store. This file is the other claim:
 * a second OPENMEMORY_DATA is a second memory, not a tenant column inside the
 * first. A fact captured in one store must not appear in the other.
 *
 * Requires a build. Skips when dist is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(
  fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
);
const CLI = path.resolve(
  fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)),
);

const runnable = existsSync(SERVER) && existsSync(CLI);

let root: string;
let clients: Client[] = [];

async function connect(name: string, dataDir: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.OPENMEMORY_DATA = dataDir;
  env.OPENMEMORY_PROVIDER = "heuristic";

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

const text = (r: { content?: Array<{ text?: string }> }) => r.content?.[0]?.text ?? "";

const call = async (
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) {
    throw new Error(`${name} failed: ${text(r)}`);
  }
  return r;
};

const json = async (
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
) => JSON.parse(text(await call(c, name, args)));

async function consolidateForReal(client: Client) {
  const result = await json(client, "consolidate", {});
  if (result.skipped) {
    const retry = await json(client, "consolidate", {});
    expect(retry.skipped).toBe(false);
    return retry;
  }
  return result;
}

function manualConsolidationOnly(dataDir: string) {
  const p = path.join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(p, "utf-8"));
  config.consolidation.triggers = ["manual"];
  config.consolidation.threshold = 100000;
  writeFileSync(p, JSON.stringify(config, null, 2));
}

beforeEach(() => {
  if (!runnable) return;
  root = mkdtempSync(path.join(tmpdir(), "om-isolate-"));
});

afterEach(async () => {
  if (!runnable) return;
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  clients = [];
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!runnable)("two data directories are two brains", () => {
  it(
    "a fact in one store is invisible in the other",
    async () => {
      const personal = path.join(root, "personal");
      const work = path.join(root, "work");
      spawnSync(process.execPath, [CLI, "init", personal], { encoding: "utf-8" });
      spawnSync(process.execPath, [CLI, "init", work], { encoding: "utf-8" });
      manualConsolidationOnly(personal);
      manualConsolidationOnly(work);

      const life = await connect("life", personal);
      const job = await connect("job", work);

      await call(life, "capture_fact", {
        content: "Alex prefers oat milk at Acme.",
      });
      await consolidateForReal(life);

      const atHome = await json(life, "search_knowledge", { query: "oat milk" });
      expect(atHome.results.length).toBeGreaterThan(0);
      expect(
        atHome.results.map((r: { fact: { content: string } }) => r.fact.content).join(" "),
      ).toContain("oat milk");

      const atWork = await json(job, "search_knowledge", { query: "oat milk" });
      expect(atWork.results).toEqual([]);
      expect(atWork.pending).toEqual([]);
    },
    60_000,
  );
});
