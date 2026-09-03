/**
 * Live HNSW sidecar against a Postgres with the `vector` extension.
 *
 * Hermetic `npm test` skips this when the URL is unset or the extension is
 * missing (the stock `postgres:16` CI image has no pgvector). The dedicated
 * CI job sets FACTHOUSE_REQUIRE_PGVECTOR=1 so a missing extension fails.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { closeDatabase, type Db } from "../../src/db/connection.js";
import { applySchema } from "../../src/db/schema.js";
import { openStore, SQLITE_MEMORY_FILENAME } from "../../src/db/store.js";
import { insertFact } from "../../src/db/facts.js";
import { insertEmbeddings } from "../../src/db/embeddings.js";
import { hasVectorExtension, sidecarIsCurrent } from "../../src/db/embeddings-hnsw.js";
import { vectorSearch } from "../../src/search/vector.js";

const liveUrl = process.env.FACTHOUSE_TEST_POSTGRES_URL?.trim();
const requireExt = process.env.FACTHOUSE_REQUIRE_PGVECTOR === "1";

let dir: string;
let db: Db | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "om-hnsw-"));
});

afterEach(async () => {
  if (db) {
    await closeDatabase(db);
    db = undefined;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("postgres HNSW (pgvector)", () => {
  it.skipIf(!requireExt)("FACTHOUSE_TEST_POSTGRES_URL has the vector extension in CI", async () => {
    expect(liveUrl).toBeTruthy();
  });

  describe.skipIf(!liveUrl)("connector", () => {
    it("builds a sidecar and the top HNSW hit matches exact cosine", async ({ skip }) => {
      writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ storage: { provider: "postgres" } }),
      );
      db = await openStore(dir, loadConfig(dir), {
        FACTHOUSE_POSTGRES_URL: liveUrl as string,
      });
      await applySchema(db);
      try {
        await db.exec("CREATE EXTENSION IF NOT EXISTS vector");
      } catch {
        /* stock Postgres images lack the package; the pgvector job has it */
      }
      if (!(await hasVectorExtension(db))) {
        if (requireExt) {
          throw new Error("vector extension missing; CI pgvector job must provide it");
        }
        skip();
      }

      const fact = await insertFact(db, {
        content: "Bookings are the grain of the orders mart at Acme.",
        domain: "pipeline",
        source_type: "conversation",
      });
      const vector = Float32Array.from([1, 0, 0, 0]);
      await insertEmbeddings(db, [{ fact_id: fact.id, vector }], "test-model", 4);

      const exact = await vectorSearch(db, vector, "test-model", 4, 5, { ann: false });
      const approx = await vectorSearch(db, vector, "test-model", 4, 5, { ann: true });
      expect(exact[0]?.id).toBe(fact.id);
      expect(approx[0]?.id).toBe(fact.id);
      expect(await sidecarIsCurrent(db, "test-model", 4)).toBe(true);
      expect(existsSync(path.join(dir, SQLITE_MEMORY_FILENAME))).toBe(false);
    });
  });
});
