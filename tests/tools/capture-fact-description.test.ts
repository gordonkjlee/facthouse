import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  captureFactDescription,
  storeHasNamedSources,
} from "../../src/tools/capture-fact-description.js";
import { DURABLE_FACT } from "../../src/intelligence/extract-prompt.js";
import { GITHUB_REPO, NPM_PACKAGE } from "../../src/identity.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) =>
  readFileSync(path.join(here, "..", "..", "src", rel), "utf8");

const PULL_SOURCES = [
  { kind: "claude-code", home: "C:\\Users\\alex\\.claude", cwd: "C:\\dev\\app" },
];

describe("storeHasNamedSources", () => {
  it("treats empty and omitted as pull-off", () => {
    expect(storeHasNamedSources(undefined)).toBe(false);
    expect(storeHasNamedSources(null)).toBe(false);
    expect(storeHasNamedSources([])).toBe(false);
    expect(storeHasNamedSources("not-an-array")).toBe(false);
  });

  it("treats a non-empty array as pull-on", () => {
    expect(storeHasNamedSources(PULL_SOURCES)).toBe(true);
    // A malformed entry still means the user intended pull — do not fall
    // through to the proactive instruction because home is missing.
    expect(storeHasNamedSources([{ kind: "claude-code" }])).toBe(true);
  });
});

describe("captureFactDescription", () => {
  it("tells an empty-sources store to capture proactively", () => {
    const text = captureFactDescription([]);
    expect(text).toMatch(/proactively whenever you learn/i);
    expect(text).toContain(DURABLE_FACT);
    expect(text).toMatch(/Capture is fast/);
    expect(text).toMatch(/Capture frequently/);
    expect(text).not.toMatch(/medical information/i);
    expect(text).not.toMatch(/personal details/i);
    expect(text.length).toBeGreaterThanOrEqual(120);
  });

  it("tells a pull store this is a correction, not recapture", () => {
    const text = captureFactDescription(PULL_SOURCES);
    expect(text).toMatch(/when you need to correct/i);
    expect(text).toMatch(/rather than whenever you learn/i);
    expect(text).toContain(DURABLE_FACT);
    expect(text).not.toMatch(/proactively/i);
    expect(text).not.toMatch(/Capture frequently/);
    expect(text).toMatch(/Capture is fast/);
    expect(text).not.toMatch(/medical information/i);
    expect(text.length).toBeGreaterThanOrEqual(120);
  });

  it("is the only copy of those leads", () => {
    // The failure this exists for: a second string in fact-manager that
    // drifts from the function. The live-server tests assert the function's
    // output is what tools/list returns; this asserts nobody inlined a third.
    expect(src("tools/fact-manager.ts")).toMatch(/captureFactDescription/);
    expect(src("tools/fact-manager.ts")).not.toMatch(
      /proactively whenever you learn/,
    );
    expect(src("tools/fact-manager.ts")).not.toMatch(
      /when you need to correct the knowledge/,
    );
    expect(src("server.ts")).toMatch(/sources:\s*config\.sources/);
  });
});

const README = readFileSync(
  path.join(here, "..", "..", "README.md"),
  "utf8",
);

describe("README instruction layer for capture and identity", () => {
  it("names this package in the opening", () => {
    const head = README.split(/\r?\n/).slice(0, 10).join("\n");
    expect(head).toContain(NPM_PACKAGE);
    expect(head).toMatch(/facthouse init/);
    expect(head).toMatch(/\*\*Data\*\*/);
    expect(head).toMatch(/\*\*Information\*\*/);
    expect(head).toMatch(/\*\*Knowledge\*\*/);
    expect(head).toContain("→");
    expect(head).toMatch(/neuroscience-inspired consolidation/);
    expect(head).toMatch(/optional semantic search/);
    expect(head).not.toMatch(/—/);
    expect(head).not.toMatch(/Wisdom/);
    expect(README).toContain(GITHUB_REPO);
    expect(README).not.toMatch(/mem0/i);
    expect(README).not.toMatch(/hosted ["']?OpenMemory/i);
    expect(README).not.toMatch(/A local memory engine any AI tool can use/);
    expect(head).not.toMatch(/abolotnov/);
  });

  it("does not describe the prune spare as a pronoun dictionary", () => {
    expect(README).not.toMatch(/pronoun resolution/i);
  });

  it("does not hardcode the proactive capture_fact instruction", () => {
    // The tool description is generated. A pasted copy in the README is a
    // second definition that will drift the moment either side changes.
    expect(README).not.toMatch(/proactively whenever you learn/i);
  });

  it("does not tell clients to search only personal categories", () => {
    expect(README).not.toMatch(
      /questions about preferences, people, or history/i,
    );
    expect(README).not.toMatch(/benefit from personal context/i);
  });
});
