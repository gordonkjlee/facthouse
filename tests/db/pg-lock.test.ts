/**
 * Live Postgres advisory lock for consolidation.
 *
 * Hermetic `npm test` skips when FACTHOUSE_TEST_POSTGRES_URL is unset.
 * The Linux CI job sets that URL and FACTHOUSE_REQUIRE_POSTGRES=1.
 * Do not key the require flag off CI=true: GitHub sets CI on Windows,
 * which has no Postgres service. Never point this at a real memory store.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import type { Db } from "../../src/db/connection.js";

const { closeDatabase } = await import("../../src/db/connection.js");
const { applySchema } = await import("../../src/db/schema.js");
const { connectPostgres } = await import("../../src/db/pg-backend.js");
const { consolidate } = await import("../../src/intelligence/consolidate.js");
const {
  acquireLock,
  getLockState,
  releaseLock,
  CONSOLIDATION_ADVISORY_LOCK_KEY,
  STALE_LOCK_MS,
} = await import("../../src/db/consolidation-lock.js");

const liveUrl = process.env.FACTHOUSE_TEST_POSTGRES_URL?.trim();
const requireLive = process.env.FACTHOUSE_REQUIRE_POSTGRES === "1";

let schema = "";
const open: Db[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) {
    await closeDatabase(db).catch(() => undefined);
  }
  if (!liveUrl || !schema) return;
  const admin = await connectPostgres(liveUrl).catch(() => null);
  if (!admin) return;
  try {
    await admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    schema = "";
    await closeDatabase(admin).catch(() => undefined);
  }
});

async function connected(): Promise<Db> {
  const db = await connectPostgres(liveUrl as string);
  open.push(db);
  await db.exec(`SET search_path TO ${schema}`);
  return db;
}

describe("postgres consolidation advisory lock", () => {
  it.skipIf(!requireLive)("FACTHOUSE_TEST_POSTGRES_URL is set in CI", () => {
    expect(liveUrl).toBeTruthy();
  });

  describe.skipIf(!liveUrl)("session lock", () => {
    it("skips a second run while the advisory lock is held", async () => {
      schema = `lh_${randomUUID().replace(/-/g, "")}`;
      const setup = await connectPostgres(liveUrl as string);
      open.push(setup);
      await setup.exec(`CREATE SCHEMA ${schema}`);
      await setup.exec(`SET search_path TO ${schema}`);
      await applySchema(setup);

      const holder = await connected();
      const other = await connected();
      expect(await acquireLock(holder, "holder-a")).toBe(true);

      const probe = await connected();
      const denied = (await probe
        .prepare(`SELECT pg_try_advisory_lock(?::bigint) AS locked`)
        .get(CONSOLIDATION_ADVISORY_LOCK_KEY)) as { locked: boolean };
      expect(denied.locked).toBe(false);

      const result = await consolidate(other, {} as never);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("Another consolidation is in progress");
      expect((await getLockState(holder))?.holder).toBe("holder-a");
      await releaseLock(holder, "holder-a");
    }, 20_000);

    it("frees the advisory lock when the holder's connection closes", async () => {
      schema = `lh_${randomUUID().replace(/-/g, "")}`;
      const setup = await connectPostgres(liveUrl as string);
      open.push(setup);
      await setup.exec(`CREATE SCHEMA ${schema}`);
      await setup.exec(`SET search_path TO ${schema}`);
      await applySchema(setup);

      const holder = await connected();
      expect(await acquireLock(holder, "holder-a")).toBe(true);
      await closeDatabase(holder);
      open.splice(open.indexOf(holder), 1);

      const probe = await connected();
      const freed = (await probe
        .prepare(`SELECT pg_try_advisory_lock(?::bigint) AS locked`)
        .get(CONSOLIDATION_ADVISORY_LOCK_KEY)) as { locked: boolean };
      expect(freed.locked).toBe(true);
      await probe.prepare(`SELECT pg_advisory_unlock(?::bigint)`).run(
        CONSOLIDATION_ADVISORY_LOCK_KEY,
      );

      const other = await connected();
      expect(await acquireLock(other, "holder-b")).toBe(false);
      expect((await getLockState(other))?.holder).toBe("holder-a");
      await releaseLock(other, "holder-b");
    }, 20_000);

    it("takes a stale row only after the advisory lock is held", async () => {
      schema = `lh_${randomUUID().replace(/-/g, "")}`;
      const setup = await connectPostgres(liveUrl as string);
      open.push(setup);
      await setup.exec(`CREATE SCHEMA ${schema}`);
      await setup.exec(`SET search_path TO ${schema}`);
      await applySchema(setup);

      const holder = await connected();
      const other = await connected();
      expect(await acquireLock(holder, "holder-a")).toBe(true);
      const stale = new Date(Date.now() - STALE_LOCK_MS - 5_000).toISOString();
      await holder.prepare(
        `UPDATE consolidation_lock SET started_at = ?, heartbeat_at = ? WHERE id = 1`,
      ).run(stale, stale);

      expect(await acquireLock(other, "holder-b")).toBe(false);
      expect((await getLockState(other))?.holder).toBe("holder-a");

      await closeDatabase(holder);
      open.splice(open.indexOf(holder), 1);

      expect(await acquireLock(other, "holder-b")).toBe(true);
      const state = await getLockState(other);
      expect(state?.holder).toBe("holder-b");
      expect(Date.parse(state!.heartbeat_at!)).toBeGreaterThan(Date.parse(stale));
      await releaseLock(other, "holder-b");
    }, 20_000);
  });
});
