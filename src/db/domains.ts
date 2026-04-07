/**
 * Data access for domain definitions.
 * All functions are synchronous (better-sqlite3).
 */

import type Database from "better-sqlite3";
import type { DomainDef } from "../types/config.js";

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/** Get all domains. */
export function getDomains(db: Database.Database): DomainDef[] {
  const rows = db.prepare(`SELECT * FROM domains`).all() as Array<{
    name: string;
    subdomains: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    name: row.name,
    subdomains: JSON.parse(row.subdomains) as string[],
  }));
}

/** Create a domain. */
export function createDomain(
  db: Database.Database,
  domain: DomainDef,
): DomainDef {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO domains (name, subdomains, created_at) VALUES (?, json(?), ?)`,
  ).run(domain.name, JSON.stringify(domain.subdomains), now);

  return { name: domain.name, subdomains: domain.subdomains };
}

/** Ensure a domain exists (idempotent). */
export function ensureDomain(db: Database.Database, name: string): void {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT OR IGNORE INTO domains (name, subdomains, created_at) VALUES (?, '[]', ?)`,
  ).run(name, now);
}
