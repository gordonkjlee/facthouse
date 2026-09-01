/**
 * The required-eval wrapper must fail closed when it is not pointed at a
 * named eval. A missing or unknown name used to be three copy-pasted files
 * that could not disagree; they now share one table, and an unknown key
 * must not spawn vitest against nothing.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WRAPPER = path.join(ROOT, "scripts", "require-eval.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [WRAPPER, ...args], {
    encoding: "utf-8",
    cwd: ROOT,
    timeout: 10_000,
  });
}

describe("require-eval wrapper", () => {
  it("exits non-zero with usage when the eval name is missing", () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage: node scripts\/require-eval\.mjs/);
    expect(r.stderr).toMatch(/first-fact/);
    expect(r.stderr).toMatch(/semantic/);
    expect(r.stderr).toMatch(/coding-store/);
    expect(r.stderr).toMatch(/http-intelligence/);
  });

  it("exits non-zero with usage when the eval name is unknown", () => {
    const r = run(["not-an-eval"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage: node scripts\/require-eval\.mjs/);
  });
});
