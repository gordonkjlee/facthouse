import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";
import {
  openDatabase,
  closeDatabase,
  withTransaction,
} from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { createSession } from "../../src/db/sessions.js";

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("async transactions", () => {
  it("queues overlapping top-level transactions on one handle", async () => {
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
  });

  it("still nests savepoints on the same async stack", async () => {
    const id = await withTransaction(db, async () => {
      const outer = await createSession(db, { source_tool: "test", project: "outer" });
      await withTransaction(db, async () => {
        await createSession(db, { source_tool: "test", project: "inner" });
      });
      return outer.id;
    });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
