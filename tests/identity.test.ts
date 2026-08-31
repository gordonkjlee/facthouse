import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_NAME,
  DEFAULT_MCP_SERVER_NAME,
  NPM_PACKAGE,
  NPM_PACKAGE_COMPAT,
  PRODUCT_NAME,
  envName,
  envValue,
  npmPackageSpec,
  subprocessGuardEnv,
} from "../src/identity.js";
import { defaultDataDir, newInstallDataDir } from "../src/paths.js";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("identity", () => {
  it("matches package.json name so the published scope cannot drift", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe(NPM_PACKAGE);
    expect(pkg.bin[CLI_NAME]).toBe("dist/cli/index.js");
    expect(pkg.bin.openmemory).toBe("dist/cli/index.js");
    expect(pkg.bin.mcp).toBe("dist/index.js");
  });

  it("keeps the linger package name distinct from the canonical one", () => {
    expect(NPM_PACKAGE_COMPAT).not.toBe(NPM_PACKAGE);
    expect(npmPackageSpec("1.2.3")).toBe(`${NPM_PACKAGE}@1.2.3`);
    expect(npmPackageSpec(null)).toBe(NPM_PACKAGE);
  });

  it("prefers FACTMEM_ over OPENMEMORY_ when both are set", () => {
    expect(
      envValue("DATA", {
        [envName("DATA")]: " /new ",
        [envName("DATA", "OPENMEMORY")]: "/old",
      }),
    ).toBe("/new");
  });

  it("still reads OPENMEMORY_ when the new prefix is absent", () => {
    expect(
      envValue("DATA", { [envName("DATA", "OPENMEMORY")]: "/old" }),
    ).toBe("/old");
  });

  it("treats whitespace as unset", () => {
    expect(envValue("DATA", { [envName("DATA")]: "  " })).toBeUndefined();
  });

  it("guards recursion on both CLI names", () => {
    const env = subprocessGuardEnv({ KEEP: "1" });
    expect(env.FACTMEM_SUBPROCESS).toBe("1");
    expect(env.OPENMEMORY_SUBPROCESS).toBe("1");
    expect(env.KEEP).toBe("1");
  });
});

describe("defaultDataDir fallback", () => {
  const home = path.join(tmpdir(), "factmem-identity-home");
  const neu = path.join(home, ".factmem");
  const old = path.join(home, ".openmemory");

  it("uses ~/.factmem when neither directory exists", () => {
    expect(
      defaultDataDir({ home, env: {}, exists: () => false }),
    ).toBe(neu);
    expect(newInstallDataDir(home)).toBe(neu);
  });

  it("keeps ~/.openmemory when that store already exists and ~/.factmem does not", () => {
    expect(
      defaultDataDir({
        home,
        env: {},
        exists: (p) => p === old,
      }),
    ).toBe(old);
  });

  it("prefers ~/.factmem when both exist", () => {
    expect(
      defaultDataDir({
        home,
        env: {},
        exists: (p) => p === neu || p === old,
      }),
    ).toBe(neu);
  });

  it("lets FACTMEM_DATA beat an existing directory", () => {
    expect(
      defaultDataDir({
        home,
        env: { FACTMEM_DATA: "/tmp/other" },
        exists: (p) => p === old,
      }),
    ).toBe(path.resolve("/tmp/other"));
  });

  it("lets OPENMEMORY_DATA beat an existing directory when FACTMEM_DATA is unset", () => {
    expect(
      defaultDataDir({
        home,
        env: { OPENMEMORY_DATA: "/tmp/legacy" },
        exists: (p) => p === neu,
      }),
    ).toBe(path.resolve("/tmp/legacy"));
  });

  it("does not invent a second brain when the old default exists", () => {
    const chosen = defaultDataDir({
      home,
      env: {},
      exists: (p) => p === old,
    });
    expect(chosen).toBe(old);
    expect(chosen).not.toBe(neu);
  });
});

describe("MCP default name", () => {
  it("is the product slug", () => {
    expect(DEFAULT_MCP_SERVER_NAME).toBe("factmem");
    expect(PRODUCT_NAME).toBe("FactMem");
  });
});
