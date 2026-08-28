/**
 * Disk budget parser and cap-driven D ingest.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { openDatabase, closeDatabase, pragmaRead } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { createSession, insertEvent } from "../../src/db/sessions.js";
import { insertFact } from "../../src/db/facts.js";
import {
  parseDiskBudget,
  formatDiskBudget,
  applySqliteDiskBudget,
  bindDiskBudget,
  DiskBudgetError,
  sqliteStoreBytes,
} from "../../src/db/disk-budget.js";

const CHUNK = "x".repeat(8000);

let db: Db;
let sessionId: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
  sessionId = (await createSession(db, { source_tool: "test", project: null })).id;
});

afterEach(async () => {
  await closeDatabase(db);
});

async function addChunk(): Promise<void> {
  await insertEvent(db, {
    mcp_session_id: sessionId,
    event_type: "tool_result",
    role: "tool",
    content: CHUNK,
  });
}

async function markAllRead(): Promise<void> {
  const seq = (
    (await db.prepare(`SELECT COALESCE(MAX(sequence), 0) v FROM session_events`).get()) as {
      v: number;
    }
  ).v;
  await db
    .prepare(
      `INSERT INTO consolidations
         (id, session_id, facts_in, facts_graduated, facts_rejected, entities_created,
          entities_linked, supersessions, summary, open_threads, last_event_sequence, created_at)
       VALUES (?, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, datetime('now'))`,
    )
    .run(`c${seq}`, seq);
}

describe("parseDiskBudget", () => {
  it("treats empty as unlimited", () => {
    expect(parseDiskBudget(null)).toBeNull();
    expect(parseDiskBudget(undefined)).toBeNull();
    expect(parseDiskBudget("")).toBeNull();
    expect(parseDiskBudget("  ")).toBeNull();
  });

  it("parses MB GB TB from one list", () => {
    expect(parseDiskBudget("512MB")).toBe(512 * 1024 * 1024);
    expect(parseDiskBudget("2GB")).toBe(2 * 1024 * 1024 * 1024);
    expect(parseDiskBudget("1 TB")).toBe(1024 * 1024 * 1024 * 1024);
    expect(parseDiskBudget("2gb")).toBe(parseDiskBudget("2GB"));
  });

  it("rejects junk rather than treating it as unlimited", () => {
    expect(() => parseDiskBudget("large")).toThrow(/Invalid retention.disk_budget/);
    expect(() => parseDiskBudget(2)).toThrow(/Invalid retention.disk_budget/);
  });
});

describe("formatDiskBudget", () => {
  it("uses GB and TB for whole multiples", () => {
    expect(formatDiskBudget(2 * 1024 * 1024 * 1024)).toBe("2 GB");
    expect(formatDiskBudget(1024 * 1024 * 1024 * 1024)).toBe("1 TB");
    expect(formatDiskBudget(512 * 1024)).toBe("0.5 MB");
  });
});

describe("cap-driven ingest", () => {
  it("accepts events under the ceiling", async () => {
    await applySqliteDiskBudget(db, 64 * 1024 * 1024);
    bindDiskBudget(db, { bytes: 64 * 1024 * 1024, keepPerSession: 50 });
    await addChunk();
    expect(
      ((await db.prepare(`SELECT COUNT(*) c FROM session_events`).get()) as { c: number }).c,
    ).toBe(1);
  });

  it("prunes unreachable D then accepts when the file is at the ceiling", async () => {
    for (let i = 0; i < 40; i++) await addChunk();
    const bytes = await sqliteStoreBytes(db);
    await applySqliteDiskBudget(db, bytes);
    bindDiskBudget(db, { bytes, keepPerSession: 0 });
    await markAllRead();

    const before = (
      (await db.prepare(`SELECT COUNT(*) c FROM session_events`).get()) as { c: number }
    ).c;
    await addChunk();
    const after = (
      (await db.prepare(`SELECT COUNT(*) c FROM session_events`).get()) as { c: number }
    ).c;
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
    const pages = await pragmaRead(db, "page_count");
    const max = await pragmaRead(db, "max_page_count");
    expect(pages).toBeLessThanOrEqual(max);
  });

  async function fillUntilRefused(): Promise<unknown> {
    for (let i = 0; i < 200; i++) {
      try {
        await addChunk();
      } catch (err) {
        return err;
      }
    }
    return undefined;
  }

  it("refuses more D when nothing is reclaimable", async () => {
    for (let i = 0; i < 20; i++) await addChunk();
    const bytes = await sqliteStoreBytes(db);
    await applySqliteDiskBudget(db, bytes);
    bindDiskBudget(db, { bytes, keepPerSession: 50 });
    const err = await fillUntilRefused();
    expect(err).toBeInstanceOf(DiskBudgetError);
    expect(
      ((await db.prepare(`SELECT COUNT(*) c FROM facts`).get()) as { c: number }).c,
    ).toBe(0);
  });

  it("does not delete facts to meet the number", async () => {
    await insertFact(db, {
      content: "Bookings are the grain of the orders mart at Acme.",
      domain: "pipeline",
      source_type: "conversation",
    });
    for (let i = 0; i < 20; i++) await addChunk();
    const bytes = await sqliteStoreBytes(db);
    await applySqliteDiskBudget(db, bytes);
    bindDiskBudget(db, { bytes, keepPerSession: 50 });
    const err = await fillUntilRefused();
    expect(err).toBeInstanceOf(DiskBudgetError);
    const fact = (await db
      .prepare(`SELECT content FROM facts`)
      .get()) as { content: string };
    expect(fact.content).toContain("Bookings are the grain");
  });
});
