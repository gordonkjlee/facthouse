import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import {
  encodeProjectDir,
  resolveSources,
  resolveUserPath,
} from "../../src/sources/resolve.js";

describe("encodeProjectDir", () => {
  it("encodes a Windows cwd the way Claude Code does on disk", () => {
    expect(encodeProjectDir("C:\\dev\\app")).toBe("C--dev-app");
  });

  it("encodes a POSIX cwd", () => {
    expect(encodeProjectDir("/home/me/app")).toBe("-home-me-app");
  });

  it("strips trailing slashes so they do not become a different group", () => {
    expect(encodeProjectDir("C:\\dev\\app\\")).toBe("C--dev-app");
    expect(encodeProjectDir("/home/me/app/")).toBe("-home-me-app");
  });
});

describe("resolveSources", () => {
  it("treats empty or omitted sources as pull-off", () => {
    expect(resolveSources([])).toEqual([]);
    expect(resolveSources(undefined)).toEqual([]);
    expect(resolveSources(null)).toEqual([]);
  });

  it("resolves a claude-code source and expands home", () => {
    const resolved = resolveSources([
      { kind: "claude-code", home: "~/.claude" },
    ]);
    expect(resolved).toEqual([
      {
        kind: "claude-code",
        home: path.join(homedir(), ".claude"),
      },
    ]);
  });

  it("keeps a Windows cwd intact so encoding still matches Claude Code", () => {
    const resolved = resolveSources([
      { kind: "claude-code", home: "/tmp/claude-home", cwd: "C:\\dev\\app" },
    ]);
    expect(resolved[0].cwd).toBe("C:\\dev\\app");
    expect(encodeProjectDir(resolved[0].cwd!)).toBe("C--dev-app");
  });

  it("rejects an unknown kind with a clear error", () => {
    expect(() =>
      resolveSources([{ kind: "grok", home: "~/.grok" }]),
    ).toThrow(/Unknown source kind "grok"/);
    expect(() =>
      resolveSources([{ kind: "grok", home: "~/.grok" }]),
    ).toThrow(/claude-code/);
  });

  it("rejects a source missing home", () => {
    expect(() => resolveSources([{ kind: "claude-code" }])).toThrow(/home/);
  });

  it("rejects a non-array sources value", () => {
    expect(() => resolveSources({ kind: "claude-code", home: "~/.claude" })).toThrow(
      /must be an array/,
    );
  });
});

describe("resolveUserPath", () => {
  it("expands a tilde home", () => {
    expect(resolveUserPath("~/.claude")).toBe(path.join(homedir(), ".claude"));
  });
});
