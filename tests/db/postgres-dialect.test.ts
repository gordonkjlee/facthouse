/**
 * Postgres dialect against PGlite — a real Postgres, not SQLite with a flag.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Db } from "../../src/db/connection.js";
import {
  applySchema,
  getSchemaVersion,
  SCHEMA_VERSION,
} from "../../src/db/schema.js";
import { closeDatabase, withTransaction } from "../../src/db/connection.js";
import { insertFact, getFact, keywordSearch } from "../../src/db/facts.js";
import { createSession, insertEvent, getEvents } from "../../src/db/sessions.js";
import { insertSessionFact } from "../../src/db/session-facts.js";
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
});
