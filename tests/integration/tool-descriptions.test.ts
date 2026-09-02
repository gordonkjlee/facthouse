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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureFactDescription } from "../../src/tools/capture-fact-description.js";
import {
  SESSION_BOOTSTRAP_INSTRUCTIONS,
  sessionContextDescription,
  buildBriefing,
} from "../../src/tools/resources.js";
import { openDatabase, closeDatabase } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";

const SERVER = path.resolve(fileURLToPath(new URL("../../dist/index.js", import.meta.url)));
const CLI = path.resolve(fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)));
const README = path.resolve(fileURLToPath(new URL("../../README.md", import.meta.url)));
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
  it("does not expose inference tools while they are off (the default)", () => {
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("capture_inference");
    expect(names).not.toContain("validate_inference");
    expect(names).not.toContain("list_inferences");
  });

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
    // Default init writes sources: [] — proactive capture is the instruction.
    expect(captureFact.description).toBe(captureFactDescription([]));

    const search = tools.find((t) => t.name === "search_knowledge")!;
    expect(search.description).toMatch(/\bbefore\b/i);
    expect(search.description).toMatch(/get_session_context/);
    // Simple mode (the default) must not spend tokens on system-time replay.
    expect(search.description).not.toMatch(/as_of_system_time/);
    expect(JSON.stringify(search.inputSchema ?? {})).not.toContain(
      "as_of_system_time",
    );

    const sessionCtx = tools.find((t) => t.name === "get_session_context")!;
    expect(sessionCtx.description).toBe(sessionContextDescription());
    expect(sessionCtx.description).toContain(SESSION_BOOTSTRAP_INSTRUCTIONS);
  });

  it("initialize instructions tell a tools-only client to load the briefing", () => {
    expect(client.getInstructions()).toBe(SESSION_BOOTSTRAP_INSTRUCTIONS);
  });

  it("get_session_context returns the same briefing as memory://briefing", async () => {
    const r: any = await client.callTool({
      name: "get_session_context",
      arguments: {},
    });
    const body = JSON.parse(r.content?.[0]?.text ?? "{}");
    const store = openDatabase(path.join(root, "memory.db"));
    await applySchema(store);
    try {
      expect(body.briefing).toBe(await buildBriefing(store));
    } finally {
      await closeDatabase(store);
    }
  });

  it("subject retrieval covers any named thing, not just people", () => {
    // get_people was replaced by get_entity precisely so a store's projects,
    // systems and suppliers are reachable — not only persons.
    const entity = tools.find((t) => t.name === "get_entity")!;
    expect(entity).toBeTruthy();
    expect(entity.description).toMatch(/organisation|project|system|any/i);
    expect(entity.description).toMatch(/role/);
    expect(entity.description).toMatch(/not a directed graph edge/);
    expect(entity.description).toMatch(/does not join two names already stored/);
    expect(entity.description).not.toMatch(/RDF/i);
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

  it("no description points an assistant at a tool that does not exist", () => {
    // Descriptions cross-refer constantly — "use search_knowledge or get_context
    // for actual recall" — which is what makes them an instruction layer rather
    // than API docs. It also means a removed tool leaves dangling pointers in
    // the text of the tools that survive.
    //
    // It happened: get_stats told every connected assistant to call get_profile
    // for recall, three releases after get_profile ceased to exist. Nothing
    // caught it, because a cross-reference reads as ordinary prose and the
    // existing checks only measure length and timing language.
    const registered = new Set(tools.map((t) => t.name));
    // Descriptions also name argument and field names (`domain_hint`), which
    // share the underscore shape. What separates a tool reference is its leading
    // verb — so take the verbs from the tools that actually exist rather than
    // from a list here that would need maintaining.
    const verbs = new Set([...registered].map((n) => n.split("_")[0]));
    const dangling: string[] = [];

    for (const t of tools) {
      for (const [ref] of (t.description ?? "").matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
        if (!verbs.has(ref.split("_")[0])) continue; // a field name, not a tool
        if (!registered.has(ref)) dangling.push(`${t.name} → ${ref}`);
      }
    }

    expect(dangling).toEqual([]);
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

describe.skipIf(!runnable)(
  "capture_fact on a pull store is a correction, not recapture",
  () => {
    let pullRoot: string;
    let pullClient: Client;
    let pullTools: Array<{ name: string; description?: string }> = [];

    const copySources = [
      {
        kind: "claude-code",
        home: "C:\\Users\\alex\\.claude",
        cwd: "C:\\dev\\app",
      },
    ];

    beforeAll(async () => {
      pullRoot = mkdtempSync(path.join(tmpdir(), "om-desc-pull-"));
      spawnSync(process.execPath, [CLI, "init", pullRoot], { encoding: "utf-8" });
      const configPath = path.join(pullRoot, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      config.sources = copySources;
      writeFileSync(configPath, JSON.stringify(config, null, 2));

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      env.OPENMEMORY_DATA = pullRoot;
      env.OPENMEMORY_PROVIDER = "heuristic";

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env,
        stderr: "ignore",
      });
      pullClient = new Client(
        { name: "desc-audit-pull", version: "1.0.0" },
        { capabilities: {} },
      );
      await pullClient.connect(transport);
      pullTools = (await pullClient.listTools()).tools;
    }, 60_000);

    afterAll(async () => {
      await pullClient?.close().catch(() => {});
      if (pullRoot) rmSync(pullRoot, { recursive: true, force: true });
    });

    it("ships the correction text from the same definition", () => {
      const captureFact = pullTools.find((t) => t.name === "capture_fact")!;
      expect(captureFact.description).toBe(captureFactDescription(copySources));
      expect(captureFact.description).not.toMatch(/proactively/i);
      expect((captureFact.description ?? "").length).toBeGreaterThanOrEqual(120);
      expect(TIMING.test(captureFact.description ?? "")).toBe(true);
    });
  },
);

describe.skipIf(!runnable)(
  "search_knowledge exposes as-of system time only in bitemporal mode",
  () => {
    let biRoot: string;
    let biClient: Client;
    let biTools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }> = [];

    beforeAll(async () => {
      biRoot = mkdtempSync(path.join(tmpdir(), "om-desc-bi-"));
      spawnSync(process.execPath, [CLI, "init", biRoot], { encoding: "utf-8" });
      const configPath = path.join(biRoot, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      config.temporal = { mode: "bitemporal", bitemporal_since: null };
      writeFileSync(configPath, JSON.stringify(config, null, 2));

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      env.OPENMEMORY_DATA = biRoot;
      env.OPENMEMORY_PROVIDER = "heuristic";

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env,
        stderr: "ignore",
      });
      biClient = new Client(
        { name: "desc-audit-bi", version: "1.0.0" },
        { capabilities: {} },
      );
      await biClient.connect(transport);
      biTools = (await biClient.listTools()).tools;
    }, 60_000);

    afterAll(async () => {
      await biClient?.close().catch(() => {});
      if (biRoot) rmSync(biRoot, { recursive: true, force: true });
    });

    it("registers as_of_system_time and says when to use it", () => {
      const search = biTools.find((t) => t.name === "search_knowledge")!;
      expect(search.description).toMatch(/as_of_system_time/);
      expect(JSON.stringify(search.inputSchema ?? {})).toContain(
        "as_of_system_time",
      );
      expect(search.description).toMatch(/believed/);
    });
  },
);

// ---------------------------------------------------------------------------
// The README is an instruction layer too
// ---------------------------------------------------------------------------

/**
 * The README ships with the package — npm includes it regardless of the `files`
 * array — and its integration sections are copy-pasted straight into client
 * rules files. So a tool name written there is an instruction, exactly like a
 * tool description, and it rots the same way.
 *
 * It did. Two domain-named read tools were removed in 0.8.0, and the README
 * kept telling users to call one of them in all three of its copy-paste blocks.
 * That shipped to npm and sat on the GitHub landing page: anyone following
 * Quick Start pasted rules instructing their assistant to call a tool the
 * server does not have.
 *
 * Same lesson as the descriptions above, one artefact over — nothing checks
 * prose, and no one re-reads a doc to confirm the code still matches it. These
 * two assertions close the loop in both directions.
 */

/** Backticked all-lowercase words — the alphabet tool names are drawn from. */
function backtickedIdentifiers(md: string): string[] {
  return [...new Set([...md.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1]))];
}

/**
 * Every tool is named `verb_noun`, so an underscore is what distinguishes a
 * tool reference from the many other lowercase words the README backticks —
 * domain names, provider names, CLI subcommands, moments.
 *
 * Matching on shape rather than keeping a list of non-tools is what stops this
 * check rotting into an inventory of README vocabulary that everyone appeases
 * and nobody reads.
 */
const TOOL_SHAPED = /^[a-z]+(_[a-z]+)+$/;

/**
 * Tool names with no underscore, which the shape rule alone would miss. Kept so
 * that removing one of these while the README still advertises it fails here
 * rather than shipping.
 */
const SINGLE_WORD_TOOLS = new Set(["consolidate"]);

/**
 * Underscore-shaped identifiers that are deliberately not tools. Short by
 * construction — anything else with an underscore must exist on the server.
 */
const NOT_TOOLS = new Set([
  "session_start", // a consolidation trigger
  "last_assistant_message", // a hook payload field
  "session_events", // the raw event table, named by the prune documentation
  "session_facts", // the staging table, named with session_events in the store model
]);

describe.skipIf(!runnable)("the README names tools that exist", () => {
  it("every tool the README names is registered on the server", () => {
    const registered = new Set(tools.map((t) => t.name));
    const phantom = backtickedIdentifiers(readFileSync(README, "utf-8"))
      .filter((id) => TOOL_SHAPED.test(id) || SINGLE_WORD_TOOLS.has(id))
      .filter((id) => !registered.has(id) && !NOT_TOOLS.has(id));
    // A non-empty list is either a removed tool the README still advertises, or
    // a new underscore-shaped identifier that belongs in NOT_TOOLS above.
    expect(phantom).toEqual([]);
  });

  it("hook and CLI examples invoke the CLI, not the MCP server", () => {
    // bin.mcp is first and is dist/index.js. `npx -y @factmem/mcp` therefore
    // starts the stdio server and hangs a hook. The CLI is
    // `npx -y -p @factmem/mcp factmem …`. MCP config uses command "npx"
    // with args; that is the server, on purpose.
    const md = readFileSync(README, "utf-8");
    const hookCmds = [...md.matchAll(/"command":\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const cmd of hookCmds) {
      if (cmd === "npx") continue;
      expect(cmd).toMatch(/\bfactmem\b/);
      expect(cmd).not.toMatch(/^npx -y @factmem\/mcp(?:@[\w.-]+)?$/);
      expect(cmd).not.toMatch(/^npx -y @factmem\/mcp(?:@[\w.-]+)? /);
    }
    for (const line of md.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("npx ")) continue;
      expect(trimmed).toMatch(/-p "@factmem\/mcp/);
      expect(trimmed).toMatch(/\bfactmem\b/);
    }
  });

  it("PowerShell examples quote the scoped package so @ is not splat", () => {
    // `@factmem/mcp` unquoted is PowerShell splatting $factmem. A tester
    // pasting Quick Start then gets a bind error, not a memory store.
    const md = readFileSync(README, "utf-8");
    const blocks = [...md.matchAll(/```powershell\r?\n([\s\S]*?)```/gi)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/-p @factmem\//);
      expect(block).toMatch(/-p "@factmem\/mcp/);
    }
  });

  it("every registered tool is named in the README", () => {
    // The reverse rot: a tool ships and no one documents it, so the only place
    // it is described is a description the user never reads.
    const md = readFileSync(README, "utf-8");
    const undocumented = tools.map((t) => t.name).filter((n) => !md.includes(`\`${n}\``));
    expect(undocumented).toEqual([]);
  });
});
