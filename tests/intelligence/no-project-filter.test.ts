/**
 * Search, the domain candidate pool, and the extract watermark stay
 * store-wide. The project a fact was recorded in is not a term in those
 * reads.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const SRC = path.resolve(fileURLToPath(new URL("../../src", import.meta.url)));

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const brace = src.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(brace, i + 1);
    }
  }
  throw new Error(`unclosed ${signature}`);
}

function forbidden(text: string): string | null {
  const body = stripComments(text);
  if (/project/i.test(body)) return "project";
  if (/JOIN\s+sessions/i.test(body)) return "JOIN sessions";
  if (/FROM\s+sessions/i.test(body)) return "FROM sessions";
  return null;
}

describe("store-wide reads do not consult project", () => {
  it("keeps project out of getFactsByDomain", () => {
    const src = readFileSync(path.join(SRC, "db", "facts.ts"), "utf8");
    const body = functionBody(src, "export async function getFactsByDomain(");
    expect(forbidden(body)).toBeNull();
  });

  it("keeps the domain cache key as the domain", () => {
    const src = readFileSync(path.join(SRC, "intelligence", "consolidate.ts"), "utf8");
    const keys = [...src.matchAll(/domainCache\.(?:get|set)\(([^)]*)\)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.toLowerCase()).not.toContain("project");
  });

  it("keeps project out of search", () => {
    const dir = path.join(SRC, "search");
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(3);
    const hits = files.flatMap((name) => {
      const found = forbidden(readFileSync(path.join(dir, name), "utf8"));
      return found ? [`${name}: ${found}`] : [];
    });
    expect(hits).toEqual([]);
  });

  it("keeps project out of the extract watermark join", () => {
    const src = readFileSync(path.join(SRC, "db", "extract-watermarks.ts"), "utf8");
    const start = src.indexOf("export const EXTRACT_WATERMARK_JOIN");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(";", start);
    expect(forbidden(src.slice(start, end))).toBeNull();
  });
});
