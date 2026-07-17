/**
 * Tool descriptions are the product's instruction layer, not API documentation.
 * They ship with the server and are the only thing telling an assistant when to
 * capture and when to search — which is what lets OpenMemory work on any MCP
 * client with no client-side rules.
 *
 * Nothing tested them, so they rotted quietly: an audit against a live server
 * found 6 of 12 tools with no timing guidance at all, `get_preferences` reading
 * in full "Get the user's preferences.", and `get_context` drifted from its own
 * specification. A description is the one artefact here that a compiler cannot
 * check and a passing test suite never exercises.
 *
 * These assert a FLOOR, not quality. A description can clear every bar below and
 * still be poor; no regex knows whether prose is compelling. What they catch is
 * the failure that actually happened — a tool shipping with a statement of
 * purpose and no occasion to call it. Judgement stays with the reviewer; this
 * stops the obvious regression.
 *
 * Asserted against a live server rather than the source, because what an
 * assistant reads is what `tools/list` returns.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(fileURLToPath(new URL("../../dist/index.js", import.meta.url)));
const CLI = path.resolve(fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)));
const runnable = existsSync(SERVER) && existsSync(CLI);

let root: string;
let client: Client;
let tools: Array<{ name: string; description?: string }> = [];

beforeAll(async () => {
  if (!runnable) return;
  root = mkdtempSync(path.join(tmpdir(), "om-desc-"));
  spawnSync(process.execPath, [CLI, "init", root], { encoding: "utf-8" });

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.OPENMEMORY_DATA = root;
  env.OPENMEMORY_PROVIDER = "heuristic";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env,
    stderr: "ignore",
  });
  client = new Client({ name: "desc-audit", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  tools = (await client.listTools()).tools;
}, 60_000);

afterAll(async () => {
  if (!runnable) return;
  await client?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/**
 * Does the description say anything about WHEN to reach for the tool?
 *
 * Deliberately generous: any triggering or timing language passes. The bar is
 * "does this give an assistant an occasion", not "is it well written".
 */
const TIMING = /\b(before|after|when|whenever|while|during|proactively|at the (start|end)|rather than|instead of|prefer)\b/i;

describe.skipIf(!runnable)("tool descriptions are an instruction layer", () => {
  it("registers the full tool surface", () => {
    // Guards the assertions below: if registration broke, every per-tool test
    // would vacuously pass over an empty list.
    // 10 after removing get_profile and get_preferences (domain-named tools)
    // and renaming get_people -> get_entity.
    expect(tools.length).toBeGreaterThanOrEqual(10);
  });

  it("every tool has a description", () => {
    const bare = tools.filter((t) => !t.description?.trim()).map((t) => t.name);
    expect(bare).toEqual([]);
  });

  it("no description is a bare statement of purpose", () => {
    // "Get the user's preferences." is 27 characters and shipped for months.
    // A description that cannot fit an occasion into its length does not have
    // one. This is a floor, not a target.
    const tooShort = tools
      .filter((t) => (t.description ?? "").length < 120)
      .map((t) => `${t.name} (${(t.description ?? "").length} chars)`);
    expect(tooShort).toEqual([]);
  });

  it("every tool says WHEN to call it", () => {
    // The failure this exists for: a tool describing what it returns and never
    // saying at what moment an assistant should reach for it.
    const noTiming = tools
      .filter((t) => !TIMING.test(t.description ?? ""))
      .map((t) => t.name);
    expect(noTiming).toEqual([]);
  });

  it("the tools an assistant must reach for unprompted push proactive use", () => {
    // These are the product thesis: capture without being asked, search before
    // answering. If their descriptions go passive, OpenMemory stops working on
    // clients that have no rules of their own — which is every client but one.
    const captureFact = tools.find((t) => t.name === "capture_fact")!;
    expect(captureFact.description).toMatch(/proactively/i);

    const search = tools.find((t) => t.name === "search_knowledge")!;
    expect(search.description).toMatch(/\bbefore\b/i);
  });

  it("subject retrieval covers any named thing, not just people", () => {
    // get_people was replaced by get_entity precisely so a store's projects,
    // systems and suppliers are reachable — not only persons.
    const entity = tools.find((t) => t.name === "get_entity")!;
    expect(entity).toBeTruthy();
    expect(entity.description).toMatch(/organisation|project|system|any/i);
  });

  it("no tool is named after a domain the engine does not ship", () => {
    // get_profile and get_preferences hardcoded domain='profile'/'preferences'
    // on an engine that ships no vocabulary. Their value moved to the briefing
    // resource and search_knowledge.
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("get_profile");
    expect(names).not.toContain("get_preferences");
    expect(names).not.toContain("get_people");
  });

  it("no description leaks a real name into shipped text", () => {
    // The spec's get_context example used the owner's partner's real name. Tool
    // descriptions ship to every client — examples must be synthetic. The
    // denylist hook guards the diff; this guards the running server.
    for (const t of tools) {
      expect(t.description ?? "").not.toMatch(/Maryna/i);
    }
  });
});
