import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_NAME,
  DEFAULT_MCP_SERVER_NAME,
  ENV_PREFIX,
  GITHUB_REPO,
  NPM_PACKAGE,
  PRODUCT_NAME,
  envName,
  envValue,
  npmPackageSpec,
  pathFreeCli,
  cliDataArg,
  subprocessGuardEnv,
} from "../src/identity.js";
import { defaultDataDir, newInstallDataDir } from "../src/paths.js";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("identity", () => {
  it("matches package.json name so the published scope cannot drift", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe(NPM_PACKAGE);
    expect(pkg.bin[CLI_NAME]).toBe("dist/cli/index.js");
    expect(pkg.bin.factmem).toBeUndefined();
    expect(pkg.bin.openmemory).toBeUndefined();
    expect(pkg.bin.mcp).toBe("dist/index.js");
    expect(pkg.repository.url).toBe(`https://github.com/${GITHUB_REPO}`);
    expect(PRODUCT_NAME).toBe("Facthouse");
    expect(DEFAULT_MCP_SERVER_NAME).toBe("facthouse");
    expect(ENV_PREFIX).toBe("FACTHOUSE");
  });

  it("does not dual-publish a linger package", () => {
    expect(npmPackageSpec("1.2.3")).toBe(`${NPM_PACKAGE}@1.2.3`);
    expect(npmPackageSpec(null)).toBe(NPM_PACKAGE);
    expect(NPM_PACKAGE).toBe("@facthouse/mcp");
  });

  it("path-free CLI quotes the package and names the bin", () => {
    expect(pathFreeCli("")).toBe(`npx -y -p "${NPM_PACKAGE}" -- ${CLI_NAME}`);
    expect(pathFreeCli("consolidate --all")).toBe(
      `npx -y -p "${NPM_PACKAGE}" -- ${CLI_NAME} consolidate --all`,
    );
    expect(cliDataArg("C:\\dev\\app\\.facthouse")).toBe("C:/dev/app/.facthouse");
    expect(cliDataArg("C:/Users/alex/My Store")).toBe('"C:/Users/alex/My Store"');
  });

  it("reads only FACTHOUSE_", () => {
    expect(
      envValue("DATA", {
        [envName("DATA")]: " /new ",
        FACTMEM_DATA: "/factmem",
        OPENMEMORY_DATA: "/old",
      }),
    ).toBe("/new");
  });

  it("does not read FACTMEM_ or OPENMEMORY_ when FACTHOUSE_ is absent", () => {
    expect(
      envValue("DATA", {
        FACTMEM_DATA: "/factmem",
        OPENMEMORY_DATA: "/old",
      }),
    ).toBeUndefined();
  });

  it("treats whitespace as unset", () => {
    expect(envValue("DATA", { [envName("DATA")]: "  " })).toBeUndefined();
  });

  it("guards recursion on the Facthouse CLI only", () => {
    const env = subprocessGuardEnv({ KEEP: "1" });
    expect(env.FACTHOUSE_SUBPROCESS).toBe("1");
    expect(env.FACTMEM_SUBPROCESS).toBeUndefined();
    expect(env.OPENMEMORY_SUBPROCESS).toBeUndefined();
    expect(env.KEEP).toBe("1");
  });
});

describe("defaultDataDir", () => {
  const home = path.join(tmpdir(), "facthouse-identity-home");
  const neu = path.join(home, ".facthouse");
  const factmem = path.join(home, ".factmem");
  const openmemory = path.join(home, ".openmemory");

  it("uses ~/.facthouse when no FACTHOUSE_DATA is set", () => {
    expect(defaultDataDir({ home, env: {} })).toBe(neu);
    expect(newInstallDataDir(home)).toBe(neu);
  });

  it("does not fall back to ~/.factmem or ~/.openmemory", () => {
    expect(defaultDataDir({ home, env: {} })).toBe(neu);
    expect(factmem).not.toBe(neu);
    expect(openmemory).not.toBe(neu);
  });

  it("lets FACTHOUSE_DATA beat the default directory", () => {
    expect(
      defaultDataDir({
        home,
        env: { FACTHOUSE_DATA: "/tmp/other" },
      }),
    ).toBe(path.resolve("/tmp/other"));
  });

  it("ignores FACTMEM_DATA and OPENMEMORY_DATA", () => {
    expect(
      defaultDataDir({
        home,
        env: {
          FACTMEM_DATA: "/tmp/factmem",
          OPENMEMORY_DATA: "/tmp/legacy",
        },
      }),
    ).toBe(neu);
  });
});
