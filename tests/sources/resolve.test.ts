import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import {
  encodeCursorProjectDir,
  encodeGrokProjectDir,
  encodeProjectDir,
  resolveSources,
  resolveUserPath,
} from "../../src/sources/resolve.js";
import { expandTilde } from "../../src/paths.js";

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

describe("encodeCursorProjectDir", () => {
  it("encodes a Windows cwd the way Cursor does on disk", () => {
    expect(encodeCursorProjectDir("C:\\dev\\app")).toBe("c-dev-app");
  });

  it("encodes a POSIX cwd without a leading hyphen", () => {
    expect(encodeCursorProjectDir("/home/me/app")).toBe("home-me-app");
  });

  it("turns dots into hyphens so a workspace file matches the folder", () => {
    expect(encodeCursorProjectDir("C:\\dev\\app.code-workspace")).toBe(
      "c-dev-app-code-workspace",
    );
  });

  it("is not Claude Code's encoding", () => {
    expect(encodeProjectDir("C:\\dev\\app")).toBe("C--dev-app");
    expect(encodeCursorProjectDir("C:\\dev\\app")).not.toBe(
      encodeProjectDir("C:\\dev\\app"),
    );
  });
});

describe("encodeGrokProjectDir", () => {
  it("URL-encodes a Windows cwd the way Grok does on disk", () => {
    expect(encodeGrokProjectDir("C:\\dev\\app")).toBe("C%3A%5Cdev%5Capp");
  });

  it("URL-encodes a POSIX cwd", () => {
    expect(encodeGrokProjectDir("/home/me/app")).toBe("%2Fhome%2Fme%2Fapp");
  });

  it("strips trailing slashes so they do not become a different group", () => {
    expect(encodeGrokProjectDir("C:\\dev\\app\\")).toBe("C%3A%5Cdev%5Capp");
    expect(encodeGrokProjectDir("/home/me/app/")).toBe("%2Fhome%2Fme%2Fapp");
  });

  it("is not Claude Code's or Cursor's encoding", () => {
    expect(encodeGrokProjectDir("C:\\dev\\app")).not.toBe(encodeProjectDir("C:\\dev\\app"));
    expect(encodeGrokProjectDir("C:\\dev\\app")).not.toBe(
      encodeCursorProjectDir("C:\\dev\\app"),
    );
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

  it("resolves a cursor source and expands home", () => {
    const resolved = resolveSources([{ kind: "cursor", home: "~/.cursor" }]);
    expect(resolved).toEqual([
      {
        kind: "cursor",
        home: path.join(homedir(), ".cursor"),
      },
    ]);
  });

  it("resolves a grok source and expands home", () => {
    const resolved = resolveSources([
      { kind: "grok", home: "~/.grok", cwd: "C:\\dev\\app" },
    ]);
    expect(resolved).toEqual([
      {
        kind: "grok",
        home: path.join(homedir(), ".grok"),
        cwd: "C:\\dev\\app",
      },
    ]);
    expect(encodeGrokProjectDir(resolved[0].cwd!)).toBe("C%3A%5Cdev%5Capp");
  });

  it("rejects an unknown kind with a clear error", () => {
    expect(() =>
      resolveSources([{ kind: "codex", home: "~/.codex" }]),
    ).toThrow(/Unknown source kind "codex"/);
    expect(() =>
      resolveSources([{ kind: "codex", home: "~/.codex" }]),
    ).toThrow(/claude-code/);
    expect(() =>
      resolveSources([{ kind: "codex", home: "~/.codex" }]),
    ).toThrow(/cursor/);
    expect(() =>
      resolveSources([{ kind: "codex", home: "~/.codex" }]),
    ).toThrow(/grok/);
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

  it("expands a backslash tilde the same way as a slash tilde", () => {
    expect(expandTilde("~\\claude")).toBe(path.join(homedir(), "claude"));
    expect(expandTilde("~/claude")).toBe(path.join(homedir(), "claude"));
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("/abs")).toBe("/abs");
  });
});
