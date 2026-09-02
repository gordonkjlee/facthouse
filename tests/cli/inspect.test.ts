import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { runInspect } from "../../src/cli/inspect.js";
import { currencyClause } from "../../src/db/facts.js";
import { renderInspectHtml } from "../../src/cli/inspect-html.js";
import { loadGraphPayload } from "../../src/cli/inspect-payload.js";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertFact, supersedeFact } = await import("../../src/db/facts.js");
const { createSource } = await import("../../src/db/sources.js");
const { ensureDomain } = await import("../../src/db/domains.js");
const { findOrCreateEntity, linkFactEntity, upsertEntityEdge, SUBJECT_OF } =
  await import("../../src/db/entities.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { insertEvent } = await import("../../src/db/sessions.js");

let db: Db;
let sourceId: string;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "om-inspect-"));
  db = openDatabase(":memory:");
  await applySchema(db);
  await ensureDomain(db, "work");
  sourceId = (
    await createSource(db, {
      type: "test",
      tool_id: null,
      raw_content: "x",
      metadata: {},
    })
  ).id;
});

afterEach(async () => {
  await closeDatabase(db);
  rmSync(dataDir, { recursive: true, force: true });
});

async function fact(content: string, extra: Partial<Parameters<typeof insertFact>[1]> = {}) {
  return insertFact(db, {
    content,
    domain: "work",
    source_type: "conversation",
    source_id: sourceId,
    ...extra,
  });
}

describe("inspect layers", () => {
  it("omits superseded facts from --layer k", async () => {
    const old = await fact("Alex preferred instant coffee");
    await supersedeFact(db, old.id, {
      content: "Alex prefers dark roast",
      domain: "work",
      source_type: "conversation",
      source_id: sourceId,
    });
    const result = await runInspect(db, { dataDir, layer: "k", limit: 10 });
    expect(result.stdout).toContain("dark roast");
    expect(result.stdout).not.toContain("instant coffee");
    const currency = currencyClause();
    const current = await db
      .prepare(`SELECT content FROM facts WHERE ${currency.sql}`)
      .all() as Array<{ content: string }>;
    expect(current.map((r) => r.content).join(" ")).toContain("dark roast");
  });

  it("lists pending I and not claimed I", async () => {
    await insertSessionFact(db, {
      session_id: "s1",
      content: "Robin owns stg_orders",
      source_origin: "inferred",
    });
    const waiting = await runInspect(db, { dataDir, layer: "i", limit: 10 });
    expect(waiting.stdout).toContain("Robin owns stg_orders");
    await db
      .prepare(`UPDATE session_facts SET consolidation_id = ?`)
      .run("c1");
    const empty = await runInspect(db, { dataDir, layer: "i", limit: 10 });
    expect(empty.stdout).toContain("Nothing is waiting to integrate");
    expect(empty.stdout).not.toContain("Robin owns stg_orders");
  });

  it("truncates D with an ellipsis, newest first", async () => {
    await insertEvent(db, {
      event_type: "message",
      role: "user",
      content: "first",
      client_session_id: "c",
    });
    await insertEvent(db, {
      event_type: "message",
      role: "assistant",
      content: "a".repeat(400),
      client_session_id: "c",
    });
    const result = await runInspect(db, { dataDir, layer: "d", limit: 10 });
    expect(result.stdout).toContain("…");
    const firstPos = result.stdout!.indexOf("assistant");
    const secondPos = result.stdout!.indexOf("user");
    expect(firstPos).toBeGreaterThan(-1);
    expect(secondPos).toBeGreaterThan(firstPos);
  });

  it("keeps type-split stg_orders as two entity rows", async () => {
    await findOrCreateEntity(db, { name: "stg_orders", type: "model" });
    await findOrCreateEntity(db, { name: "stg_orders", type: "table" });
    const result = await runInspect(db, { dataDir, layer: "entities", limit: 10 });
    expect(result.stdout).toContain("model");
    expect(result.stdout).toContain("table");
    expect((result.stdout!.match(/stg_orders/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("prints a co_mentioned edge and a fact_entities histogram", async () => {
    const alex = await findOrCreateEntity(db, { name: "Alex", type: "person" });
    const acme = await findOrCreateEntity(db, { name: "Acme", type: "org" });
    const f = await fact("Alex works at Acme");
    await linkFactEntity(db, f.id, alex.entity.id, SUBJECT_OF);
    await linkFactEntity(db, f.id, acme.entity.id, "mentioned");
    await upsertEntityEdge(db, alex.entity.id, acme.entity.id, "co_mentioned");
    const result = await runInspect(db, { dataDir, layer: "graph", limit: 10 });
    expect(result.stdout).toContain("co_mentioned");
    expect(result.stdout).toContain("Typed links on facts");
    expect(result.stdout).toMatch(/subject_of\s+1/);
  });
});

describe("inspect graph HTML", () => {
  it("writes under the data dir and embeds type-split names plus a low-degree node", async () => {
    const hub = await findOrCreateEntity(db, { name: "Acme", type: "org" });
    for (let i = 0; i < 12; i++) {
      const e = await findOrCreateEntity(db, { name: `Person ${i}`, type: "person" });
      await upsertEntityEdge(db, hub.entity.id, e.entity.id, "co_mentioned");
    }
    await findOrCreateEntity(db, { name: "Helios", type: "place" });
    await findOrCreateEntity(db, { name: "stg_orders", type: "model" });
    await findOrCreateEntity(db, { name: "stg_orders", type: "table" });
    const result = await runInspect(db, { dataDir, graph: true, limit: 5 });
    expect(result.path).toBe(path.join(dataDir, "inspect.html"));
    expect(existsSync(result.path!)).toBe(true);
    const html = readFileSync(result.path!, "utf8");
    expect(html).toContain("Helios");
    expect(html).toContain("stg_orders");
    expect(html).toContain('id="q"');
    expect(html).toContain('id="type"');
    expect(html).toContain('id="cap"');
    expect(html).toContain('"cap":5');
  });

  it("marks --entity on a type-split name", async () => {
    await findOrCreateEntity(db, { name: "stg_orders", type: "model" });
    await findOrCreateEntity(db, { name: "stg_orders", type: "table" });
    const payload = await loadGraphPayload(db, { cap: 50, entity: "stg_orders" });
    expect(payload.selectedId).toBeTruthy();
    const selected = payload.nodes.find((n) => n.id === payload.selectedId);
    expect(selected?.name).toBe("stg_orders");
  });

  it("empty store still writes a page", async () => {
    const html = renderInspectHtml({
      nodes: [],
      edges: [],
      facts: [],
      links: [],
      info: [],
      events: [],
      sources: [],
      iToD: [],
      dByEntity: {},
      eventCount: 0,
      eventShown: 0,
      dCap: 36,
      selectedId: null,
      cap: 50,
    });
    expect(html).toContain("Nothing selected");
    expect(html).toContain("const DATA =");
    expect(html).toContain('id="viewSpend"');
    expect(html).toContain("spend-board");
    expect(html).toContain("Catch-up");
    expect(html).toContain("More detail");
    expect(html).toContain("#spend:target");
    expect(html).toContain("hashchange");
    expect(html).toContain("#10130f");
    expect(html).toContain("#c4a35a");
    expect(html).toContain("rel=\"icon\"");
    expect(html).toContain("brand-mark");
  });

  it("Spend includes a routing card that copies JSON and does not save", async () => {
    const { intelligenceRoutingView } = await import(
      "../../src/intelligence/routing-view.js"
    );
    const html = renderInspectHtml({
      nodes: [],
      edges: [],
      facts: [],
      links: [],
      info: [],
      events: [],
      sources: [],
      iToD: [],
      dByEntity: {},
      eventCount: 0,
      eventShown: 0,
      dCap: 36,
      selectedId: null,
      cap: 50,
      routing: intelligenceRoutingView({ provider: "cli", api_key: null }),
    });
    expect(html).toContain("Local extract");
    expect(html).toContain("Copy JSON");
    expect(html).toContain("Inspect does not save");
    expect(html).toContain("factmem settings");
    expect(html).not.toMatch(/TTY init/);
    expect(html).toContain("http://localhost:1234/v1");
    expect(html).not.toMatch(/writeFile|save config/i);
  });

  it("inspect --json includes package_version", async () => {
    const result = await runInspect(db, {
      dataDir,
      json: true,
      packageVersion: "0.22.0",
    });
    const parsed = JSON.parse(result.stdout!);
    expect(parsed.package_version).toBe("0.22.0");
    expect(parsed.health.intelligence.last_24h.calls).toBe(0);
  });
});
