import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import {
  encodeCursorProjectDir,
  encodeGrokSessionDir,
  encodeProjectDir,
  projectKey,
  projectRelation,
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

describe("projectKey", () => {
  it("folds every client spelling of one cwd onto one key", () => {
    expect(projectKey("C%3A%5Cdev%5Capp")).toBe("c-dev-app");
    expect(projectKey("C--dev-app")).toBe("c-dev-app");
    expect(projectKey("c-dev-app")).toBe("c-dev-app");
    expect(projectKey("C:\\dev\\app")).toBe("c-dev-app");
  });

  it("matches a percent-encoded group to the cwd it names", () => {
    for (const cwd of [
      "C:\\dev\\app",
      "/home/alex/app",
      "/home/alex/my app",
      "C:\\Program Files (x86)\\app",
    ]) {
      expect(projectKey(encodeGrokSessionDir(cwd))).toBe(projectKey(cwd));
    }
    // Literal group name: parentheses are `%28` and `%29`, the same bytes
    // `urlencoding::encode` writes.
    const x86 = "C:\\Program Files (x86)\\app";
    expect(projectKey("C%3A%5CProgram%20Files%20%28x86%29%5Capp")).toBe(projectKey(x86));
    expect(projectKey(x86)).toBe("c-program-files-x86-app");
  });

  it("returns null when the value is not a cwd", () => {
    expect(projectKey("app-0123456789abcdef")).toBeNull();
    expect(projectKey("12345")).toBeNull();
    expect(projectKey("")).toBeNull();
    expect(projectKey("%E0%A4%A")).toBeNull();
    expect(projectKey(null)).toBeNull();
    expect(projectKey("   ")).toBeNull();
    expect(projectKey("***")).toBeNull();
  });

  it("returns null only for a short slug-plus-hash group", () => {
    const atLimit = "a".repeat(40) + "-0123456789abcdef";
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(57);
    expect(projectKey(atLimit)).toBeNull();
    const over = "a".repeat(41) + "-0123456789abcdef";
    expect(Buffer.byteLength(over, "utf8")).toBe(58);
    expect(projectKey(over)).toBe(over);
  });
});

describe("projectRelation", () => {
  it("is not comparable when either key is missing", () => {
    expect(projectRelation(null, null)).toBe("not_comparable");
    expect(projectRelation("12345", null)).toBe("not_comparable");
    expect(projectRelation("", "c-dev-app")).toBe("not_comparable");
    expect(projectRelation("c-dev-app", "%E0%A4%A")).toBe("not_comparable");
  });

  it("treats a worktree or subdirectory launch as the same project", () => {
    expect(projectRelation("c-dev-app", "c-dev-app-pkg")).toBe("same");
    expect(projectRelation("c-dev-app-pkg", "c-dev-app")).toBe("same");
    expect(projectRelation("/home/alex/app", "/home/alex/app/pkg")).toBe("same");
    expect(projectRelation("C--dev-app", "C--dev-app-pkg")).toBe("same");
    expect(projectRelation("c-dev-app", "c-dev-app")).toBe("same");
  });

  it("does not treat a shared name fragment as the same project", () => {
    expect(projectRelation("acme", "C--dev-acme-warehouse")).toBe("different");
    expect(projectRelation("c-dev-app", "c-dev-application")).toBe("different");
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

  it("rejects an unknown kind with a clear error", () => {
    expect(() =>
      resolveSources([{ kind: "codex", home: "~/.codex" }]),
    ).toThrow(/Unknown source kind "codex"/);
    expect(() =>
      resolveSources([{ kind: "codex", home: "~/.codex" }]),
    ).toThrow(/This version supports "claude-code", "cursor" and "grok"\./);
  });

  it("accepts grok as a copy kind", () => {
    expect(resolveSources([{ kind: "grok", home: "~/.grok", cwd: "C:\\dev\\app" }])).toEqual([
      { kind: "grok", home: path.join(homedir(), ".grok"), cwd: "C:\\dev\\app" },
    ]);
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
