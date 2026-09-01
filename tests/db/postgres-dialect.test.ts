/**
 * Postgres dialect against PGlite — a real Postgres, not SQLite with a flag.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../../src/db/connection.js";
import {
  applySchema,
  getSchemaVersion,
  SCHEMA_VERSION,
} from "../../src/db/schema.js";
import { closeDatabase, withTransaction } from "../../src/db/connection.js";
import { attachPostgres } from "../../src/db/postgres.js";
import { insertFact, getFact, keywordSearch } from "../../src/db/facts.js";
import { createSession, insertEvent, getEvents } from "../../src/db/sessions.js";
import {
  insertSessionFact,
  linkFactSource,
  getFactSources,
} from "../../src/db/session-facts.js";
import { createEntity, findEntity } from "../../src/db/entities.js";
import { ensureDomain, getDomains } from "../../src/db/domains.js";
import { openPgliteDatabase } from "../helpers/pglite-store.js";

const GRAIN = "Bookings are the grain of the orders mart at Acme.";

describe("postgres dialect (PGlite)", () => {
  let db: Db;

  beforeAll(async () => {
    db = await openPgliteDatabase();
  }, 60_000);

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  it("applies the current schema once and is idempotent", async () => {
    expect(db.dialect).toBe("postgres");
    expect(await getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    await applySchema(db);
    expect(await getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("round-trips a graduated fact and finds it by keyword", async () => {
    const fact = await insertFact(db, {
      content: GRAIN,
      domain: "pipeline",
      source_type: "conversation",
    });
    expect(fact.is_latest).toBe(true);
    const read = await getFact(db, fact.id);
    expect(read?.content).toBe(GRAIN);
    expect(read?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const hits = await keywordSearch(db, "bookings");
    expect(hits.map((h) => h.fact.id)).toContain(fact.id);

    const quoted = await keywordSearch(db, '"bookings"');
    expect(quoted.map((h) => h.fact.id)).toContain(fact.id);
  });

  it("accepts source_quality http", async () => {
    const fact = await insertFact(db, {
      content: "Alex prefers tea.",
      domain: "preferences",
      source_type: "conversation",
      source_quality: "http",
    });
    expect(fact.source_quality).toBe("http");
  });

  it("stores a named speaker on an event", async () => {
    const session = await createSession(db, { source_tool: "test", project: "atlas" });
    const event = await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: GRAIN,
      speaker: "Alex",
    });
    expect(event.speaker).toBe("Alex");
    const events = await getEvents(db, session.id);
    expect(events[0].speaker).toBe("Alex");
  });

  it("ignores duplicate session facts", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    const first = await insertSessionFact(db, {
      session_id: session.id,
      content: GRAIN,
    });
    const second = await insertSessionFact(db, {
      session_id: session.id,
      content: GRAIN,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("creates a domain with json subdomains", async () => {
    await ensureDomain(db, "pipeline", ["grain"]);
    const domains = await getDomains(db);
    expect(domains.map((d) => d.name)).toContain("pipeline");
    const pipeline = domains.find((d) => d.name === "pipeline");
    expect(pipeline?.subdomains).toEqual(["grain"]);
  });

  it("finds an entity by canonical name", async () => {
    await createEntity(db, { type: "person", name: "Alex" });
    const found = await findEntity(db, "Alex");
    expect(found?.name).toBe("Alex");
  });

  it("queues overlapping transactions and nests savepoints", async () => {
    const order: string[] = [];
    const first = withTransaction(db, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      await createSession(db, { source_tool: "test", project: "a" });
      order.push("a-end");
      return 1;
    });
    const second = withTransaction(db, async () => {
      order.push("b-start");
      await createSession(db, { source_tool: "test", project: "b" });
      order.push("b-end");
      return 2;
    });
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);

    const nested = await withTransaction(db, async () => {
      const outer = await createSession(db, { source_tool: "test", project: "outer" });
      await withTransaction(db, async () => {
        await createSession(db, { source_tool: "test", project: "inner" });
      });
      return outer.id;
    });
    expect(nested).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("meaning-search stays exact without pgvector and does not create a sidecar", async () => {
    const { insertEmbeddings } = await import("../../src/db/embeddings.js");
    const { sidecarIsCurrent } = await import("../../src/db/embeddings-hnsw.js");
    const { vectorSearch } = await import("../../src/search/vector.js");
    const { resetAnnWarningState, postgresMissingVectorWarning } = await import(
      "../../src/search/ann.js"
    );
    resetAnnWarningState();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };
    try {
      const fact = await insertFact(db, {
        content: GRAIN,
        domain: "pipeline",
        source_type: "conversation",
      });
      const vector = Float32Array.from([1, 0]);
      await insertEmbeddings(db, [{ fact_id: fact.id, vector }], "m", 2);
      const hits = await vectorSearch(db, vector, "m", 2, 5, { ann: true });
      expect(hits.map((h) => h.id)).toContain(fact.id);
      expect(await sidecarIsCurrent(db, "m", 2)).toBe(false);
      expect(errors.join("")).toContain(postgresMissingVectorWarning());
    } finally {
      console.error = orig;
    }
  });

  it("accepts backing extraction types", async () => {
    const session = await createSession(db, { source_tool: "test", project: null });
    const fact = await insertSessionFact(db, {
      session_id: session.id,
      content: "Assent fixture sentence.",
    });
    const event = await insertEvent(db, {
      mcp_session_id: session.id,
      event_type: "message",
      role: "user",
      content: "yes",
    });
    expect(fact).not.toBeNull();
    await linkFactSource(db, {
      session_fact_id: fact!.id,
      event_id: event.id,
      relevance: 0.7,
      extraction_type: "assent",
    });
    const sources = await getFactSources(db, fact!.id);
    expect(sources.map((s) => s.extraction_type)).toContain("assent");
  });

  it("reports database size and refuses D ingest at a 1-byte budget", async () => {
    const { getStats } = await import("../../src/db/stats.js");
    const { bindDiskBudget, DiskBudgetError, storeBytes } = await import(
      "../../src/db/disk-budget.js"
    );
    const size = await storeBytes(db);
    expect(size).toBeGreaterThan(0);
    const stats = await getStats(db);
    expect(stats.store?.bytes).toBe(size);

    bindDiskBudget(db, { bytes: 1, keepPerSession: 50 });
    const session = await createSession(db, { source_tool: "test", project: null });
    await expect(
      insertEvent(db, {
        mcp_session_id: session.id,
        event_type: "message",
        role: "user",
        content: GRAIN,
      }),
    ).rejects.toThrow(DiskBudgetError);
  });
});

describe("postgres schema 18 widens an existing store", () => {
  it("lets a v17 CHECK accept assent after applySchema", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    const legacy = attachPostgres({
      async query(sql, params) {
        const result = await pg.query(sql, params ?? []);
        return {
          rows: result.rows as Record<string, unknown>[],
          rowCount: result.affectedRows ?? result.rowCount ?? result.rows.length,
        };
      },
      async exec(sql) {
        await pg.exec(sql);
      },
      async close() {
        await pg.close();
      },
    });
    await legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE session_fact_sources (
        session_fact_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relevance DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        extraction_type TEXT NOT NULL DEFAULT 'contextual'
          CHECK (extraction_type IN ('primary', 'corroborating', 'contextual')),
        PRIMARY KEY (session_fact_id, event_id)
      );
      INSERT INTO schema_migrations (version) VALUES (17);
    `);
    await applySchema(legacy);
    expect(await getSchemaVersion(legacy)).toBe(SCHEMA_VERSION);
    await legacy
      .prepare(
        `INSERT INTO session_fact_sources
           (session_fact_id, event_id, relevance, extraction_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run("f1", "e1", 0.7, "assent");
    const row = (await legacy
      .prepare(
        `SELECT extraction_type FROM session_fact_sources WHERE session_fact_id = ?`,
      )
      .get("f1")) as { extraction_type: string };
    expect(row.extraction_type).toBe("assent");
    await closeDatabase(legacy);
  }, 60_000);
});
