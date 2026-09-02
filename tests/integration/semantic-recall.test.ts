/**
 * Semantic recall against a real embedding model, through the real server.
 *
 * Every other test in this suite stubs the provider, which proves the wiring
 * and nothing about whether semantic search works. The claim the feature exists
 * to make — that a query sharing no words with a fact can still find it — is a
 * claim about an embedding model's behaviour, and only a real model can settle
 * it. This is the test the README's semantic paragraph is written against.
 *
 * It also drives the server rather than the library: capture, consolidate and
 * search all arrive as MCP tool calls over stdio, so the config plumbing, the
 * provider construction at boot, and the tuning threaded into search are all
 * exercised the way a client would exercise them. The unit tests cover none of
 * that, because in-process callers pass the arguments directly.
 *
 * Opt-in: needs Ollama running locally with `nomic-embed-text` pulled, so
 * `npm test` skips it rather than failing on a machine without one.
 *
 * A skipped test reads as a passing one — this project once shipped 184
 * "passing" tests that had silently skipped — and a printed warning is not a
 * safeguard, because the runner swallows console output from a file it skipped.
 * So the requirement is assertable instead: `npm run test:semantic` sets
 * OPENMEMORY_REQUIRE_SEMANTIC_EVAL=1, and the first block below then *fails*
 * when no model is reachable rather than quietly verifying nothing. Run it
 * before claiming semantic search works.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(fileURLToPath(new URL("../../dist/index.js", import.meta.url)));
const CLI = path.resolve(fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)));

const OLLAMA = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MODEL = "nomic-embed-text";

/** Is a live model actually reachable? Answered once, out loud. */
async function probeOllama(): Promise<string | null> {
  if (!existsSync(SERVER) || !existsSync(CLI)) return "dist/ is not built";
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return `Ollama at ${OLLAMA} returned ${res.status}`;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map((m) => m.name ?? "");
    if (!names.some((n) => n.startsWith(MODEL))) {
      return `Ollama has no ${MODEL} (run: ollama pull ${MODEL})`;
    }
    return null;
  } catch (err) {
    return `Ollama not reachable at ${OLLAMA}: ${(err as Error).message}`;
  }
}

const unavailable = await probeOllama();

/** Set when this run is expected to actually verify something. */
const required = process.env.OPENMEMORY_REQUIRE_SEMANTIC_EVAL === "1";

describe.runIf(required)("the semantic eval is required in this run", () => {
  it("has a live embedding model to verify against", () => {
    // The whole point of the flag. Without this, a run with no model reachable
    // would skip the suite below and report success having verified nothing.
    expect(unavailable).toBeNull();
  });
});

let root: string;
let clients: Client[] = [];

async function connect(dataDir: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.OPENMEMORY_DATA = dataDir;
  // Heuristic intelligence keeps this hermetic — the embedding provider is the
  // only live dependency under test, and mixing in a second one would make a
  // failure ambiguous.
  env.OPENMEMORY_PROVIDER = "heuristic";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "semantic-eval", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const textOf = (r: any) => r.content?.[0]?.text ?? "";

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return r;
};
const json = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(textOf(await call(c, name, args)));

/** Turn semantic search on the way the README tells a user to. */
function enableEmbeddings(dataDir: string, over: Record<string, unknown> = {}) {
  const p = path.join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(p, "utf-8"));
  config.embedding = { ...config.embedding, provider: "ollama", model: MODEL, ...over };
  // Explicit calls only: the server's scheduler could otherwise hold the
  // consolidation lock when the test asks, and the test would read an
  // unembedded store and blame the embeddings.
  config.consolidation.triggers = ["manual"];
  config.consolidation.threshold = 100000;
  writeFileSync(p, JSON.stringify(config, null, 2));
}

/**
 * Synthetic, and deliberately so — this is a memory product dogfooded on real
 * data, and a fixture is a public artefact. Four unrelated facts, chosen so
 * that each probe query below has exactly one defensible answer or none.
 */
const FACTS = [
  "Alex is allergic to shellfish",
  "Alex prefers dark mode in every editor",
  "Alex works as a software engineer at Acme",
  "Alex's colleague Robin runs the platform team",
];

async function seed(client: Client) {
  for (const content of FACTS) await call(client, "capture_fact", { content });
  const result = await json(client, "consolidate", {});
  const done = result.skipped ? await json(client, "consolidate", {}) : result;
  expect(done.skipped).toBe(false);
  // The premise of everything below. Without it a later empty search would look
  // like a recall failure rather than an empty store.
  expect(done.facts_integrated).toBe(FACTS.length);
}

const contents = (response: any): string[] =>
  (response.results ?? []).map((r: any) => r.fact.content);

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  clients = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

function freshStore(): string {
  root = mkdtempSync(path.join(tmpdir(), "om-semantic-"));
  spawnSync(process.execPath, [CLI, "init", root], { encoding: "utf-8" });
  return root;
}

describe.skipIf(unavailable)(
  // Named with the reason so a verbose run says why it did nothing.
  unavailable ? `semantic recall — SKIPPED: ${unavailable}` : "semantic recall against a live model",
  () => {
  it(
    "finds a fact by meaning that keyword search cannot find by word",
    async () => {
      const dir = freshStore();
      enableEmbeddings(dir);
      const client = await connect(dir);
      await seed(client);

      // The exact claim in the README. "food" appears in no fact.
      const semantic = await json(client, "search_knowledge", { query: "food" });
      expect(contents(semantic)).toContain("Alex is allergic to shellfish");

      // And the control that makes the first assertion mean something: the
      // same store, a query about something it holds nothing on. Without this,
      // a model that scored every fact highly for every query would pass.
      const nothing = await json(client, "search_knowledge", { query: "quantum physics" });
      expect(contents(nothing)).toEqual([]);
    },
    120_000,
  );

  it(
    "does not lose the keyword matches it already had",
    async () => {
      // The regression that would matter most: semantic ranks, it does not
      // gate. A query that worked before embeddings must still work after.
      const dir = freshStore();
      enableEmbeddings(dir);
      const client = await connect(dir);
      await seed(client);

      const hits = await json(client, "search_knowledge", { query: "shellfish" });
      expect(contents(hits)).toContain("Alex is allergic to shellfish");

      const editor = await json(client, "search_knowledge", { query: "dark mode" });
      expect(contents(editor)).toContain("Alex prefers dark mode in every editor");
    },
    120_000,
  );

  it(
    "reports full coverage once the store has been consolidated",
    async () => {
      const dir = freshStore();
      enableEmbeddings(dir);
      const client = await connect(dir);
      await seed(client);

      const stats = await json(client, "get_stats", {});
      expect(stats.embeddings).toHaveLength(1);
      expect(stats.embeddings[0].model).toBe(MODEL);
      // Coverage is only meaningful against the fact count — a bare count of 4
      // would be full coverage here and a failed run on a larger store.
      expect(stats.embeddings[0].count).toBe(stats.facts.active_latest);
    },
    120_000,
  );

  it(
    "answers nothing rather than everything when the floor is disabled and then set",
    async () => {
      // Both halves of the noise-floor finding, on a real model, in one store.
      //
      // Without a floor the whole store comes back for a query it cannot
      // answer — not because ranking is broken, but because cosine has no
      // natural zero and unrelated facts score a tight band that no relative
      // cutoff can distinguish from a cluster of good matches.
      const dir = freshStore();
      enableEmbeddings(dir, { min_similarity: 0 });
      const client = await connect(dir);
      await seed(client);

      // Some facts, not a specific number. How many survive depends on where
      // the relative cutoff happens to fall inside a band of noise, which is a
      // property of this model on this fixture rather than of the behaviour
      // under test. The behaviour under test is that anything comes back at
      // all for a question the store cannot answer.
      const flooded = await json(client, "search_knowledge", { query: "quantum physics" });
      expect(contents(flooded).length).toBeGreaterThan(0);

      await client.close();
      clients = [];

      // Same store, same model, floor restored to the provider's measured
      // value. This is what ships.
      enableEmbeddings(dir, { min_similarity: null });
      const client2 = await connect(dir);
      const quiet = await json(client2, "search_knowledge", { query: "quantum physics" });
      expect(contents(quiet)).toEqual([]);
    },
    120_000,
  );
  },
);
