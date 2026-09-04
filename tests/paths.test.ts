import { describe, it, expect } from "vitest";
import { acceptTypedPath, looksLikeUserPath } from "../src/paths.js";

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
