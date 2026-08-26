/**
 * Data access for domain definitions.
 */

import type { Db } from "./connection.js";
import type { DomainDef } from "../types/config.js";

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/** Get all domains. */
export async function getDomains(db: Db): Promise<DomainDef[]> {
  const rows = (await db.prepare(`SELECT * FROM domains`).all()) as Array<{
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
export async function createDomain(
  db: Db,
  domain: DomainDef,
): Promise<DomainDef> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO domains (name, subdomains, created_at) VALUES (?, json(?), ?)`,
    )
    .run(domain.name, JSON.stringify(domain.subdomains), now);

  return { name: domain.name, subdomains: domain.subdomains };
}

/** Ensure a domain exists (idempotent). */
export async function ensureDomain(
  db: Db,
  name: string,
  subdomains: string[] = [],
): Promise<void> {
  const now = new Date().toISOString();

  // INSERT OR IGNORE, so an existing domain keeps whatever subdomains it has
  // rather than being reset by a caller that doesn't know about them.
  await db
    .prepare(
      `INSERT OR IGNORE INTO domains (name, subdomains, created_at) VALUES (?, json(?), ?)`,
    )
    .run(name, JSON.stringify(subdomains), now);
}
