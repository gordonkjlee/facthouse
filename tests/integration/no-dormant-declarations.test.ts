/**
 * Declarations that describe behaviour no code implements.
 *
 * Four of these were found in two days, each by accident, each having shipped
 * for months:
 *
 *   - `search.embedding_provider` — a config field naming an embedding backend
 *     that did not exist. Replaced when semantic search was actually built.
 *   - `retention.session_facts_days` — read by nothing. It looked like the
 *     control for a database that had grown to 493 MB, which is worse than
 *     absent: a setting that looks like a safeguard stops anyone looking
 *     further.
 *   - `corroborating` — defined in the schema's CHECK constraint and documented
 *     in the types as "mentioned again", never written. Every repeat of a fact
 *     was recorded as its origin instead.
 *   - a `degraded` flag on the embedding provider, copied from the extraction
 *     provider because the pattern was fresh in mind. Caught in review before it
 *     shipped, which is the only reason it is not on this list.
 *
 * They share a shape: a declaration is cheap to add and invisible when unused,
 * so the gap between what the schema and config *say* and what the code *does*
 * widens silently. Nothing in a type checker or a test suite notices, because
 * an unused constant is valid code.
 *
 * This is the deliberate version of the accident. It asks two questions a
 * reviewer cannot reliably ask by eye:
 *
 *   1. Is every value the schema permits ever written?
 *   2. Is every field the shipped config declares ever read?
 *
 * Both allow explicit exemptions, with a reason. An exemption is a decision
 * recorded in one place; silence is a decision nobody made.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(fileURLToPath(new URL("../../src", import.meta.url)));

/** Every .ts file under src/, with its path. */
function sourceFiles(dir = SRC): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) {
      out.push({ file: path.relative(SRC, full), text: readFileSync(full, "utf-8") });
    }
  }
  return out;
}

/**
 * Strip comments before searching.
 *
 * Not fussiness. The first version of this test matched `event_types` inside a
 * prose comment that happened to list the config arrays, and so reported a
 * genuinely dormant field as being in use. A guard against declarations that
 * exist only in writing must not itself be satisfied by writing.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const FILES = sourceFiles();
const textOutside = (...exclude: string[]) =>
  FILES.filter((f) => !exclude.some((e) => f.file.replace(/\\/g, "/") === e))
    .map((f) => stripComments(f.text))
    .join("\n");

// ---------------------------------------------------------------------------
// 1. Values the schema permits but nothing writes
// ---------------------------------------------------------------------------

/**
 * Enum values that are deliberately never written by this codebase.
 *
 * Keep this list short and reasoned. A value here is a promise that its absence
 * is intentional; a value quietly missing from the code is the bug this test
 * exists to catch.
 */
const UNWRITTEN_BY_DESIGN = new Map<string, string>([
  // Event shapes a client may log through `log_event`. The server accepts and
  // stores whatever arrives, so it never needs to name these itself — they come
  // from the caller, and the CHECK constraint is what validates them.
  ["tool_call", "logged by clients, not produced by the server"],
  ["artifact", "logged by clients, not produced by the server"],
  ["image", "content_type a client may declare"],
  ["audio", "content_type a client may declare"],
  ["binary", "content_type a client may declare"],
  ["json", "content_type a client may declare"],
]);

function checkConstraintValues(): Map<string, string[]> {
  const schema = readFileSync(path.join(SRC, "db", "schema.ts"), "utf-8");
  const byColumn = new Map<string, string[]>();
  // CHECK (col IN ('a', 'b')) — the only form this schema uses.
  const re = /CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)/g;
  for (const m of schema.matchAll(re)) {
    const values = [...m[2].matchAll(/'([^']+)'/g)].map((v) => v[1]);
    if (values.length === 0) continue;
    const existing = byColumn.get(m[1]) ?? [];
    byColumn.set(m[1], [...new Set([...existing, ...values])]);
  }
  return byColumn;
}

describe("the schema permits nothing the code cannot produce", () => {
  it("finds CHECK constraints to examine at all", () => {
    // Without this, a change to the schema's formatting would silently empty
    // the test below and it would pass having examined nothing.
    const found = checkConstraintValues();
    expect(found.size).toBeGreaterThan(4);
    expect(found.get("extraction_type")).toContain("corroborating");
  });

  it("every permitted value is written somewhere", () => {
    const code = textOutside("db/schema.ts");
    const dormant: string[] = [];

    for (const [column, values] of checkConstraintValues()) {
      for (const value of values) {
        if (UNWRITTEN_BY_DESIGN.has(value)) continue;
        // A quoted literal, which is how every one of these reaches the DB.
        if (!code.includes(`"${value}"`) && !code.includes(`'${value}'`)) {
          dormant.push(`${column} = '${value}'`);
        }
      }
    }

    // A non-empty list is a value the database accepts that nothing can put
    // there — either a feature that was never finished, or one that regressed.
    // If it is deliberate, say so in UNWRITTEN_BY_DESIGN with a reason.
    expect(dormant).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Config fields the defaults declare but nothing reads
// ---------------------------------------------------------------------------

/**
 * Field names nothing needs to read.
 *
 * `provider` and `model` are read via computed access in the provider
 * selectors, and `domains` is consumed as a whole object rather than by name.
 */
const UNREAD_BY_DESIGN = new Map<string, string>([
  ["subdomains", "part of a domain definition, consumed as an object"],
  [
    "api_key",
    "belongs to the 'api' intelligence provider, which provider.ts states is " +
      "not implemented and falls back to heuristic. A known gap rather than a " +
      "silent one — but it must not be advertised as working, so if the " +
      "provider is dropped this field goes with it.",
  ],
]);

/** Leaf field names in DEFAULT_CONFIG — the config this product actually ships. */
function shippedConfigFields(): string[] {
  const text = readFileSync(path.join(SRC, "types", "config.ts"), "utf-8");
  const start = text.indexOf("DEFAULT_CONFIG");
  expect(start).toBeGreaterThan(-1);
  const body = text.slice(start);
  // `field: value` at any nesting depth. Snake_case only, which every config
  // key in this project uses — it excludes TypeScript type members above.
  return [...new Set([...body.matchAll(/^\s+([a-z][a-z0-9_]*)\s*:/gm)].map((m) => m[1]))];
}

describe("the shipped config declares nothing that is never read", () => {
  it("finds config fields to examine at all", () => {
    const fields = shippedConfigFields();
    expect(fields.length).toBeGreaterThan(10);
    expect(fields).toContain("min_similarity");
  });

  it("every declared field is read somewhere", () => {
    const code = textOutside("types/config.ts");
    const dormant = shippedConfigFields().filter((field) => {
      if (UNREAD_BY_DESIGN.has(field)) return false;
      // Property access, destructuring, or a quoted key — any of the ways a
      // setting actually gets consumed.
      return !new RegExp(`[.\\[]\\s*["']?${field}\\b|\\b${field}\\s*[,}=]`).test(code);
    });

    // A field here is a setting a user can change with no effect — which is
    // worse than a missing setting, because it reads as a working control.
    expect(dormant).toEqual([]);
  });
});
