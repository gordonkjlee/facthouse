import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import { SOURCE_MTIME_META } from "../../src/intelligence/line-time.js";

const { openDatabase, closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { insertEvent } = await import("../../src/db/sessions.js");
const { measureHistoricSelection } = await import(
  "../../src/intelligence/historic-selection.js"
);

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("measureHistoricSelection", () => {
  it("counts all unexamined for all", async () => {
    for (let i = 0; i < 3; i++) {
      await insertEvent(db, {
        client_session_id: "sess-aaa",
        event_type: "message",
        role: "user",
        content: "x".repeat(50),
      });
    }
    const sel = await measureHistoricSelection(db, { kind: "all" }, 2000);
    expect(sel.chosenCount).toBe(3);
    expect(sel.truncatedChars).toBe(150);
  });

  it("truncates each line at max_content_length", async () => {
    await insertEvent(db, {
      client_session_id: "sess-aaa",
      event_type: "message",
      role: "user",
      content: "y".repeat(3000),
    });
    const sel = await measureHistoricSelection(db, { kind: "all" }, 2000);
    expect(sel.chosenCount).toBe(1);
    expect(sel.truncatedChars).toBe(2000);
  });

  it("7d skips older said-at and uses Cursor file mtime", async () => {
    const now = Date.now();
    await insertEvent(db, {
      client_session_id: "claude-old",
      event_type: "message",
      role: "user",
      content: "old",
      occurred_at: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await insertEvent(db, {
      client_session_id: "claude-new",
      event_type: "message",
      role: "user",
      content: "new",
      occurred_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await insertEvent(db, {
      client_session_id: "cursor-old",
      event_type: "message",
      role: "user",
      content: "cursor-old",
      occurred_at: null,
      metadata: {
        [SOURCE_MTIME_META]: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    await insertEvent(db, {
      client_session_id: "cursor-new",
      event_type: "message",
      role: "user",
      content: "cursor-new",
      occurred_at: null,
      metadata: {
        [SOURCE_MTIME_META]: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    const sel = await measureHistoricSelection(db, { kind: "days", days: 7 }, 2000);
    expect(sel.chosenCount).toBe(2);
  });
});
