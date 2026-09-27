import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { runInspect } from "../../src/cli/inspect.js";
import { currencyClause } from "../../src/db/facts.js";
import { renderInspectHtml } from "../../src/cli/inspect-html.js";
import {
  addSequenceRadius,
  firstIndexAtOrAfter,
  latestUserInSequenceWindow,
  loadGraphPayload,
} from "../../src/cli/inspect-payload.js";
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

  it("attaches newest Data samples by entity name without requiring provenance", async () => {
    const alex = await findOrCreateEntity(db, { name: "Alex", type: "person" });
    await insertEvent(db, {
      event_type: "message",
      role: "user",
      content: "Alex prefers dark roast",
      client_session_id: "c1",
    });
    await insertEvent(db, {
      event_type: "message",
      role: "assistant",
      content: "Noted.",
      client_session_id: "c1",
    });
    const payload = await loadGraphPayload(db, { cap: 50 });
    const node = payload.nodes.find((n) => n.id === alex.entity.id);
    expect(node?.dCount).toBe(1);
    const ids = payload.dByEntity[alex.entity.id] ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(
      payload.events.some((e) => ids.includes(e.id) && /dark roast/.test(e.content)),
    ).toBe(true);
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
    expect(html).toContain('cx="16.00"');
    expect(html).toContain('cx="6.20"');
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
    expect(html).toContain("facthouse settings");
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

  it("walks conversation context by sequence window, not the whole chat", () => {
    const list = [1, 3, 10, 11, 12, 20].map((sequence) => ({
      id: `e${sequence}`,
      sequence,
      role: sequence === 10 ? "user" : "assistant",
      content: "ok",
    }));
    expect(firstIndexAtOrAfter(list, 11)).toBe(3);
    expect(firstIndexAtOrAfter(list, 2)).toBe(1);
    expect(firstIndexAtOrAfter([], 1)).toBe(0);
    expect(latestUserInSequenceWindow(list, 12, 8, () => false)).toBe("e10");
    expect(latestUserInSequenceWindow(list, 20, 8, () => false)).toBeNull();
    expect(
      latestUserInSequenceWindow(
        [{ id: "u", sequence: 2, role: "user", content: "x" }],
        10,
        8,
        () => false,
      ),
    ).toBe("u");
    const near = new Set<string>();
    addSequenceRadius(near, list, 12, 3);
    expect([...near].sort()).toEqual(["e10", "e11", "e12"]);
  });

  it("type-split names share the same Data sample ids", async () => {
    const model = await findOrCreateEntity(db, { name: "stg_orders", type: "model" });
    const table = await findOrCreateEntity(db, { name: "stg_orders", type: "table" });
    await insertEvent(db, {
      event_type: "message",
      role: "user",
      content: "stg_orders is the fact table",
      client_session_id: "c1",
    });
    const payload = await loadGraphPayload(db, { cap: 50 });
    const a = payload.dByEntity[model.entity.id] ?? [];
    const b = payload.dByEntity[table.entity.id] ?? [];
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(payload.nodes.find((n) => n.id === model.entity.id)?.dCount).toBe(1);
    expect(payload.nodes.find((n) => n.id === table.entity.id)?.dCount).toBe(1);
  });

  it("dCount matches includes across many names", async () => {
    const names = ["Alex", "Robin", "Acme", "Helios", "stg_orders"];
    const created = [];
    for (const name of names) {
      created.push(await findOrCreateEntity(db, { name, type: "person" }));
    }
    const lines = [
      "Alex prefers dark roast at Acme",
      "Robin lives near Helios",
      "stg_orders and Alex",
      "unrelated padding",
      "Acme hired Robin",
    ];
    for (const content of lines) {
      await insertEvent(db, {
        event_type: "message",
        role: "user",
        content,
        client_session_id: "c-eq",
      });
    }
    const payload = await loadGraphPayload(db, { cap: 50 });
    for (let i = 0; i < names.length; i++) {
      const needle = names[i]!.toLowerCase();
      const expectCount = lines.filter((l) => l.toLowerCase().includes(needle)).length;
      const node = payload.nodes.find((n) => n.id === created[i]!.entity.id);
      expect(node?.dCount).toBe(expectCount);
    }
  });

  it("Data context stays local in a long conversation", async () => {
    const alex = await findOrCreateEntity(db, { name: "Alex", type: "person" });
    for (let i = 0; i < 80; i++) {
      await insertEvent(db, {
        event_type: "message",
        role: i === 40 ? "user" : "assistant",
        content: i === 40 ? "Alex prefers dark roast" : `padding ${i}`,
        client_session_id: "long-chat",
      });
    }
    const payload = await loadGraphPayload(db, { cap: 50 });
    const ids = payload.dByEntity[alex.entity.id] ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(20);
    expect(payload.events.length).toBeLessThan(20);
    expect(
      payload.events.some((e) => ids.includes(e.id) && /dark roast/.test(e.content)),
    ).toBe(true);
  });
});
