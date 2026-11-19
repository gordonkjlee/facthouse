/**
 * A fresh profile needs no `facthouse init`.
 *
 * The server creates the default directory, or `FACTHOUSE_DATA` when that
 * is set, and an empty SQLite record store. A captured fact is findable
 * from that store. Requires a build. Skips when dist is absent.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SQLITE_MEMORY_FILENAME } from "../../src/db/store.js";

const SERVER = path.resolve(
  fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
);

const runnable = existsSync(SERVER);

const FACT =
  "In project facthouse-first-run, Alex keeps the kestrel note on the status page.";

let clients: Client[] = [];
let roots: string[] = [];

function childEnv(home: string, dataDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.FACTHOUSE_DATA;
  delete env.FACTHOUSE_STORAGE;
  delete env.FACTHOUSE_POSTGRES_URL;
  env.HOME = home;
  env.USERPROFILE = home;
  env.FACTHOUSE_PROVIDER = "heuristic";
  if (dataDir) env.FACTHOUSE_DATA = dataDir;
  return env;
}

async function connect(name: string, env: Record<string, string>): Promise<Client> {
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

const textOf = (result: { content?: Array<{ text?: string }> }) =>
  result.content?.[0]?.text ?? "";

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${textOf(result)}`);
  }
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function remembered(payload: Record<string, unknown>): string {
  const pending = Array.isArray(payload.pending)
    ? payload.pending.map((row) => {
        const fact = row as { content?: string };
        return fact.content ?? "";
      })
    : [];
  const results = Array.isArray(payload.results)
    ? payload.results.map((row) => {
        const hit = row as { fact?: { content?: string } };
        return hit.fact?.content ?? "";
      })
    : [];
  return [...pending, ...results].join("\n");
}

async function saveAndFind(client: Client): Promise<void> {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  expect(names).toContain("capture_fact");
  expect(names).toContain("search_knowledge");
  expect(names).toContain("get_session_context");

  const saved = await callJson(client, "capture_fact", {
    content: FACT,
    domain_hint: "facthouse-first-run",
  });
  expect(saved.duplicate).toBe(false);

  const found = await callJson(client, "search_knowledge", { query: "kestrel" });
  expect(remembered(found)).toContain("kestrel");
}

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  clients = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe.skipIf(!runnable)("first run creates an empty record store", () => {
  it(
    "a fresh home with no ~/.facthouse saves a fact and finds it",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "fh-first-"));
      roots.push(root);
      const home = path.join(root, "home");
      mkdirSync(home);
      const store = path.join(home, ".facthouse");
      expect(existsSync(store)).toBe(false);

      const client = await connect("fresh-home", childEnv(home));
      await saveAndFind(client);

      expect(existsSync(path.join(store, SQLITE_MEMORY_FILENAME))).toBe(true);
      expect(existsSync(path.join(store, "config.json"))).toBe(false);
    },
    60_000,
  );

  it(
    "FACTHOUSE_DATA is the store, including when that directory does not exist yet",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "fh-data-"));
      roots.push(root);
      const home = path.join(root, "home");
      const custom = path.join(root, "custom-store");
      mkdirSync(home);
      expect(existsSync(custom)).toBe(false);

      const client = await connect("custom-data", childEnv(home, custom));
      await saveAndFind(client);

      expect(existsSync(path.join(custom, SQLITE_MEMORY_FILENAME))).toBe(true);
      expect(existsSync(path.join(custom, "config.json"))).toBe(false);
      expect(existsSync(path.join(home, ".facthouse"))).toBe(false);
    },
    60_000,
  );
});
