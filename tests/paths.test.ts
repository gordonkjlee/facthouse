import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  acceptTypedPath,
  cliStoreDir,
  defaultDataDir,
  findNearestFacthouseStore,
  looksLikeUserPath,
} from "../src/paths.js";

describe("looksLikeUserPath", () => {
  it("accepts empty, drives, tildes, dots, and separators", () => {
    expect(looksLikeUserPath("")).toBe(true);
    expect(looksLikeUserPath("C:\\dev\\app")).toBe(true);
    expect(looksLikeUserPath("C:/dev/app")).toBe(true);
    expect(looksLikeUserPath("~/.facthouse")).toBe(true);
    expect(looksLikeUserPath("./store")).toBe(true);
    expect(looksLikeUserPath("/tmp/x")).toBe(true);
  });

  it("rejects a sentence and a bare word", () => {
    expect(looksLikeUserPath("please put it next to the repo")).toBe(false);
    expect(looksLikeUserPath("not a path at all")).toBe(false);
    expect(looksLikeUserPath("please")).toBe(false);
  });
});

describe("acceptTypedPath", () => {
  it("accepts a bare name only when that folder already exists", () => {
    expect(acceptTypedPath("app", () => false)).toBe(false);
    expect(acceptTypedPath("app", () => true)).toBe(true);
    expect(acceptTypedPath("./app", () => false)).toBe(true);
  });
});

describe("findNearestFacthouseStore", () => {
  // Absolute on every platform. `path.join("C:", …)` is relative on POSIX, so
  // path.resolve(cwd) inside the walker would not match the exists stub.
  const app = path.resolve("/tmp/facthouse-walk/app");
  const store = path.join(app, ".facthouse");
  const nested = path.join(app, "src");
  const marker = path.join(store, "config.json");
  const exists = (p: string) => p === marker || p === store;

  it("finds .facthouse in cwd", () => {
    expect(findNearestFacthouseStore(app, exists)).toBe(store);
  });

  it("walks up from a nested folder", () => {
    expect(findNearestFacthouseStore(nested, exists)).toBe(store);
  });

  it("uses cwd when it is the store directory", () => {
    expect(findNearestFacthouseStore(store, exists)).toBe(store);
  });

  it("returns undefined when none exists", () => {
    expect(findNearestFacthouseStore(app, () => false)).toBeUndefined();
  });

  it("prefers the nearer store when a parent also has one", () => {
    const parentStore = path.join(path.dirname(app), ".facthouse");
    const parentMarker = path.join(parentStore, "config.json");
    const existsBoth = (p: string) => p === marker || p === parentMarker;
    expect(findNearestFacthouseStore(app, existsBoth)).toBe(store);
  });

  it("skips a .facthouse directory that has no config.json", () => {
    expect(findNearestFacthouseStore(app, (p) => p === store)).toBeUndefined();
  });

  it("does not treat a custom store folder as a walk-up hit", () => {
    const customMarker = path.join(app, "memory", "config.json");
    expect(
      findNearestFacthouseStore(app, (p) => p === customMarker),
    ).toBeUndefined();
  });
});

describe("cliStoreDir", () => {
  const home = path.resolve("/tmp/facthouse-walk-home");
  const app = path.resolve("/tmp/facthouse-walk/app");
  const store = path.join(app, ".facthouse");
  const marker = path.join(store, "config.json");
  const exists = (p: string) => p === marker;

  it("prefers FACTHOUSE_DATA over a project store", () => {
    expect(
      defaultDataDir({
        home,
        cwd: app,
        exists,
        walkUp: true,
        env: { FACTHOUSE_DATA: "C:/tmp/explicit" },
      }),
    ).toBe(path.resolve("C:/tmp/explicit"));
  });

  it("uses the project store when env is unset", () => {
    expect(
      defaultDataDir({
        home,
        cwd: app,
        exists,
        walkUp: true,
        env: {},
      }),
    ).toBe(store);
  });

  it("falls back to ~/.facthouse when walk-up finds nothing", () => {
    expect(
      defaultDataDir({
        home,
        cwd: app,
        exists: () => false,
        walkUp: true,
        env: {},
      }),
    ).toBe(path.join(home, ".facthouse"));
  });

  it("does not walk up when walkUp is unset (MCP)", () => {
    expect(
      defaultDataDir({
        home,
        cwd: app,
        exists,
        env: {},
      }),
    ).toBe(path.join(home, ".facthouse"));
  });

  it("cliStoreDir walks up", () => {
    expect(cliStoreDir({}, app, exists)).toBe(store);
  });
});
