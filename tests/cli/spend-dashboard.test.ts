import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const { insertSessionFact } = await import("../../src/db/session-facts.js");
const { insertFact } = await import("../../src/db/facts.js");
const { createSource } = await import("../../src/db/sources.js");
const { ensureDomain } = await import("../../src/db/domains.js");
const { setConversationExtractThrough } = await import(
  "../../src/db/extract-watermarks.js"
);
const { insertIntelligenceRun } = await import("../../src/db/intelligence-runs.js");
const { loadSpendDashboard, spendBucketKey, rollSpendDays } = await import(
  "../../src/cli/spend-dashboard.js"
);

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("loadSpendDashboard", () => {
  it("splits a day's events into examined vs unread and counts I/K", async () => {
    const e1 = await insertEvent(db, {
      event_type: "message",
      role: "user",
      content: "Bookings are the grain of the orders mart at Acme.",
      client_session_id: "chat-a",
    });
    const e2 = await insertEvent(db, {
      event_type: "message",
      role: "user",
      content: "stg_orders is missing booked_at.",
      client_session_id: "chat-a",
    });
    await db.prepare(`UPDATE session_events SET created_at = ? WHERE id = ?`).run(
      "2026-08-20T10:00:00.000Z",
      e1.id,
    );
    await db.prepare(`UPDATE session_events SET created_at = ? WHERE id = ?`).run(
      "2026-08-20T11:00:00.000Z",
      e2.id,
    );
    await setConversationExtractThrough(db, { kind: "client", id: "chat-a" }, e1.sequence);

    await insertSessionFact(db, {
      session_id: "s1",
      content: "Bookings are the grain of the orders mart at Acme.",
    });
    await db
      .prepare(`UPDATE session_facts SET created_at = ?`)
      .run("2026-08-20T12:00:00.000Z");

    await ensureDomain(db, "warehouse");
    const source = await createSource(db, {
      type: "test",
      tool_id: null,
      raw_content: "x",
      metadata: {},
    });
    await insertFact(db, {
      content: "Bookings are the grain of the orders mart at Acme.",
      domain: "warehouse",
      source_type: "conversation",
      source_id: source.id,
    });
    await db.prepare(`UPDATE facts SET created_at = ?`).run("2026-08-20T13:00:00.000Z");

    const now = new Date("2026-08-28T12:00:00.000Z");
    const dash = await loadSpendDashboard(db, now, 14);
    const day = dash.days.find((d) => d.day === "2026-08-20");
    expect(day).toBeTruthy();
    expect(day!.logged).toBe(2);
    expect(day!.examined).toBe(1);
    expect(day!.unread).toBe(1);
    expect(day!.staged).toBe(1);
    expect(day!.integrated).toBe(1);
    expect(dash.days).toHaveLength(14);
    expect(dash.days[0].day).toBe("2026-08-15");
    expect(dash.days[13].day).toBe("2026-08-28");
  });

  it("rolls billed runs onto the UTC day they ran", async () => {
    await insertIntelligenceRun(db, {
      kind: "consolidate",
      usage: {
        calls: 5,
        elapsed_ms: 1000,
        input_tokens: 50,
        output_tokens: 5,
        stages: {
          extract: {
            provider: "cli",
            model: "haiku",
            calls: 5,
            elapsed_ms: 1000,
            input_tokens: 50,
            output_tokens: 5,
          },
        },
      },
      createdAt: "2026-08-21T08:00:00.000Z",
    });
    const dash = await loadSpendDashboard(
      db,
      new Date("2026-08-28T00:00:00.000Z"),
      14,
    );
    const day = dash.days.find((d) => d.day === "2026-08-21");
    expect(day!.calls).toBe(5);
    expect(day!.input_tokens).toBe(50);
    expect(dash.runs).toHaveLength(1);
    expect(dash.runs[0].stages.extract.model).toBe("haiku");
  });

  it("defaults to a year of UTC days so month grain has 12 bars", async () => {
    const dash = await loadSpendDashboard(db, new Date("2026-08-28T00:00:00.000Z"));
    expect(dash.days).toHaveLength(366);
    expect(dash.days[0].day).toBe("2025-08-28");
    expect(dash.days[365].day).toBe("2026-08-28");
  });
});

describe("spendBucketKey / rollSpendDays", () => {
  it("puts Friday in the UTC week that started Monday", () => {
    expect(spendBucketKey("2026-08-28", "day")).toBe("2026-08-28");
    expect(spendBucketKey("2026-08-28", "week")).toBe("2026-08-24");
    expect(spendBucketKey("2026-08-24", "week")).toBe("2026-08-24");
    expect(spendBucketKey("2026-08-23", "week")).toBe("2026-08-17");
    expect(spendBucketKey("2026-08-28", "month")).toBe("2026-08-01");
  });

  it("sums a week's days onto the Monday", () => {
    const days = [
      {
        day: "2026-08-27",
        logged: 10,
        examined: 4,
        unread: 6,
        staged: 1,
        integrated: 2,
        calls: 3,
        input_tokens: 100,
      },
      {
        day: "2026-08-28",
        logged: 5,
        examined: 1,
        unread: 4,
        staged: 2,
        integrated: 3,
        calls: 7,
        input_tokens: 50,
      },
    ];
    const weeks = rollSpendDays(days, "week");
    expect(weeks).toHaveLength(1);
    expect(weeks[0].day).toBe("2026-08-24");
    expect(weeks[0].logged).toBe(15);
    expect(weeks[0].unread).toBe(10);
    expect(weeks[0].calls).toBe(10);
    expect(weeks[0].input_tokens).toBe(150);
    expect(rollSpendDays(days, "day")).toBe(days);
  });
});
