import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../../src/db/connection.js";
import { SOURCE_QUALITY_VALUES } from "../../src/types/data.js";
import { SCHEMA_VERSION } from "../../src/db/schema-version.js";

const { openDatabase, closeDatabase, pragmaWrite } = await import(
  "../../src/db/connection.js"
);
const { applySchema, getSchemaVersion } = await import("../../src/db/schema.js");

let db: Db;

beforeEach(async () => {
  db = openDatabase(":memory:");
  await applySchema(db);
});

afterEach(async () => {
  await closeDatabase(db);
});

describe("source_quality http", () => {
  it("accepts http on facts and session_facts", async () => {
    await db
      .prepare(
        `INSERT INTO facts (
          id, content, domain, source_type, created_at, source_quality
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("f1", "Alex prefers tea.", "preferences", "conversation", "2026-08-31T00:00:00.000Z", "http");
    await db
      .prepare(
        `INSERT INTO session_facts (
          id, session_id, content, content_hash, created_at, source_quality
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("sf1", "s1", "Alex prefers tea.", "h1", "2026-08-31T00:00:00.000Z", "http");
    const fact = (await db.prepare(`SELECT source_quality FROM facts WHERE id = ?`).get("f1")) as {
      source_quality: string;
    };
    const staged = (await db
      .prepare(`SELECT source_quality FROM session_facts WHERE id = ?`)
      .get("sf1")) as { source_quality: string };
    expect(fact.source_quality).toBe("http");
    expect(staged.source_quality).toBe("http");
  });

  it("is the one CHECK list in schema 23 and Postgres DDL", () => {
    const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const expected = SOURCE_QUALITY_VALUES.map((v) => `'${v}'`).join(", ");
    const schema = readFileSync(path.join(root, "src/db/schema.ts"), "utf-8");
    const pg = readFileSync(path.join(root, "src/db/postgres-schema.ts"), "utf-8");
    expect(SOURCE_QUALITY_VALUES).toContain("http");
    expect(schema).toContain(expected);
    expect(pg).toContain(expected);
  });

  it("rebuilds a schema 22 facts table so http is legal", async () => {
    const legacy = openDatabase(":memory:");
    try {
      await legacy.exec(`
        CREATE TABLE facts (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          domain TEXT NOT NULL,
          subdomain TEXT,
          confidence REAL NOT NULL DEFAULT 0.7,
          importance REAL NOT NULL DEFAULT 0.5,
          source_type TEXT NOT NULL,
          source_tool TEXT,
          source_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          superseded_by TEXT,
          is_latest INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          valid_from TEXT,
          valid_until TEXT,
          system_retired_at TEXT,
          session_id TEXT,
          capture_context TEXT,
          access_count INTEGER NOT NULL DEFAULT 0,
          source_quality TEXT NOT NULL DEFAULT 'heuristic'
            CHECK (source_quality IN ('heuristic', 'cli', 'sampling', 'explicit')),
          speaker_role TEXT,
          speaker TEXT
        );
      `);
      await pragmaWrite(legacy, "user_version = 22");
      await expect(
        legacy
          .prepare(
            `INSERT INTO facts (id, content, domain, source_type, created_at, source_quality)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "f0",
            "Alex prefers tea.",
            "preferences",
            "conversation",
            "2026-08-31T00:00:00.000Z",
            "http",
          ),
      ).rejects.toThrow();
      await applySchema(legacy);
      expect(await getSchemaVersion(legacy)).toBe(SCHEMA_VERSION);
      await legacy
        .prepare(
          `INSERT INTO facts (id, content, domain, source_type, created_at, source_quality)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "f1",
          "Alex prefers tea.",
          "preferences",
          "conversation",
          "2026-08-31T00:00:00.000Z",
          "http",
        );
      const row = (await legacy
        .prepare(`SELECT source_quality FROM facts WHERE id = ?`)
        .get("f1")) as { source_quality: string };
      expect(row.source_quality).toBe("http");
    } finally {
      await closeDatabase(legacy);
    }
  });
});
