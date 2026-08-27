import { describe, it, expect } from "vitest";
import { rewriteToPostgres } from "../../src/db/postgres.js";

describe("rewriteToPostgres", () => {
  it("rewrites placeholders, OR IGNORE, and json()", () => {
    const sql = rewriteToPostgres(
      `INSERT OR IGNORE INTO domains (name, subdomains, created_at) VALUES (?, json(?), ?)`,
    );
    expect(sql).toContain("$1");
    expect(sql).toContain("$2::jsonb");
    expect(sql).toContain("$3");
    expect(sql).not.toContain("?");
    expect(sql).toMatch(/ON CONFLICT DO NOTHING\s*$/);
    expect(sql).not.toMatch(/OR IGNORE/i);
  });

  it("rewrites INSERT OR REPLACE on fact_embeddings", () => {
    const sql = rewriteToPostgres(
      `INSERT OR REPLACE INTO fact_embeddings
         (fact_id, model, dimensions, vector, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    expect(sql).toMatch(/ON CONFLICT \(fact_id\) DO UPDATE SET/);
    expect(sql).toContain("$5");
  });

  it("rewrites pgvector placeholders without eating ::vector", () => {
    const sql = rewriteToPostgres(
      `SELECT fact_id, (embedding <=> ?::vector) AS dist FROM fact_embeddings_hnsw ORDER BY embedding <=> ?::vector LIMIT ?`,
    );
    expect(sql).toContain("$1::vector");
    expect(sql).toContain("$2::vector");
    expect(sql).toContain("$3");
    expect(sql).not.toContain("?");
  });

  it("rewrites datetime('now') and BEGIN IMMEDIATE", () => {
    expect(rewriteToPostgres(`valid_until > datetime('now')`)).toBe(
      `valid_until > now()`,
    );
    expect(rewriteToPostgres("BEGIN IMMEDIATE")).toBe("BEGIN");
  });

  it("does not rewrite placeholders inside string literals", () => {
    expect(rewriteToPostgres(`SELECT '?' AS q, ?`)).toBe(`SELECT '?' AS q, $1`);
  });
});
