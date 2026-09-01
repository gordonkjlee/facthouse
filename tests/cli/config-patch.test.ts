import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONFIG_FILENAME,
  ConfigDocumentError,
  defaultServerConfig,
  mergeConfig,
  readConfigDocument,
  writeConfigDocument,
} from "../../src/config.js";
import {
  HTTP_DEFAULT_BASE_URL,
  applyInitOverlay,
  applyMoreOverlayToIntelligence,
  moreShownFromConfig,
  patchConfigDocument,
  SHIPPED_MORE_SHOWN,
} from "../../src/cli/init-knobs.js";
import {
  httpIsOptedIn,
} from "../../src/intelligence/http.js";
import {
  DEFAULT_HTTP_STAGES,
  resolveStageProviderType,
} from "../../src/intelligence/stage-router.js";
import type { ServerConfig } from "../../src/types/config.js";

function mergedIntel(doc: Record<string, unknown>): ServerConfig {
  return mergeConfig(defaultServerConfig(), doc) as ServerConfig;
}

describe("readConfigDocument / writeConfigDocument", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("throws missing and does not mkdir", () => {
    dir = mkdtempSync(path.join(tmpdir(), "om-cfg-"));
    const missing = path.join(dir, "no-such");
    expect(() => readConfigDocument(missing)).toThrow(ConfigDocumentError);
    try {
      readConfigDocument(missing);
    } catch (err) {
      expect((err as ConfigDocumentError).code).toBe("missing");
    }
    expect(existsSync(missing)).toBe(false);
  });

  it("throws malformed and leaves bytes unchanged", () => {
    dir = mkdtempSync(path.join(tmpdir(), "om-cfg-"));
    const raw = "{ not json";
    writeFileSync(path.join(dir, CONFIG_FILENAME), raw);
    expect(() => readConfigDocument(dir)).toThrow(ConfigDocumentError);
    try {
      readConfigDocument(dir);
    } catch (err) {
      expect((err as ConfigDocumentError).code).toBe("malformed");
    }
    expect(readFileSync(path.join(dir, CONFIG_FILENAME), "utf-8")).toBe(raw);
  });

  it("throws not-object for null, array, and string JSON", () => {
    dir = mkdtempSync(path.join(tmpdir(), "om-cfg-"));
    for (const body of ["null", "[]", "\"\""]) {
      writeFileSync(path.join(dir, CONFIG_FILENAME), body);
      try {
        readConfigDocument(dir);
        expect.unreachable();
      } catch (err) {
        expect((err as ConfigDocumentError).code).toBe("not-object");
      }
      expect(readFileSync(path.join(dir, CONFIG_FILENAME), "utf-8")).toBe(body);
    }
  });

  it("writeConfigDocument refuses a missing file", () => {
    dir = mkdtempSync(path.join(tmpdir(), "om-cfg-"));
    const missing = path.join(dir, "absent");
    mkdirSync(missing);
    expect(() => writeConfigDocument(missing, { a: 1 })).toThrow(ConfigDocumentError);
    expect(existsSync(path.join(missing, CONFIG_FILENAME))).toBe(false);
  });
});

describe("SHIPPED_MORE_SHOWN vs dump", () => {
  it("init enable default is cli; resolved CLI extract on_fail is none", () => {
    expect(SHIPPED_MORE_SHOWN.httpExtractOnFail).toBe("cli");
    expect(SHIPPED_MORE_SHOWN.httpExtract).toBe(false);
    expect(moreShownFromConfig(defaultServerConfig(), {}).httpExtractOnFail).toBe(
      "none",
    );
    expect(moreShownFromConfig(defaultServerConfig(), {}).httpExtract).toBe(false);
  });
});

describe("patchConfigDocument", () => {
  it("ignores sneaky storage / provider / ann / interlocutor / disk_budget", () => {
    const doc: Record<string, unknown> = { consolidation: { threshold: 99 } };
    const sneaky = {
      cliTimeoutMs: 60_000,
      storage: { provider: "postgres" },
      intelligence: { provider: "heuristic" },
      embeddingProvider: "voyage" as const,
      ann: true,
      interlocutor: { role_weights: { user: 2 } },
      disk_budget: "2GB",
    };
    const { next, written } = patchConfigDocument(doc, sneaky);
    expect(next.storage).toBeUndefined();
    expect(next.interlocutor).toBeUndefined();
    expect((next.intelligence as Record<string, unknown>).provider).toBeUndefined();
    expect(next.embedding).toBeUndefined();
    expect(next.consolidation).toEqual({ threshold: 99 });
    expect(written).toEqual(["intelligence.cli.timeout_ms"]);
    expect(
      (next.intelligence as { cli: { timeout_ms: number } }).cli.timeout_ms,
    ).toBe(60_000);
  });

  it("does not fill sibling defaults on a slim file", () => {
    const doc: Record<string, unknown> = { consolidation: { threshold: 99 } };
    const { next } = patchConfigDocument(doc, { cliTimeoutMs: 60_000 });
    const intel = next.intelligence as Record<string, unknown>;
    expect(intel.provider).toBeUndefined();
    expect(intel.api_key).toBeUndefined();
    expect(Object.keys(intel.cli as object)).toEqual(["timeout_ms"]);
  });

  it("empty overlay is identity", () => {
    const doc: Record<string, unknown> = { consolidation: { threshold: 99 } };
    const { next, written } = patchConfigDocument(doc, {});
    expect(written).toEqual([]);
    expect(JSON.stringify(next)).toBe(JSON.stringify(doc));
  });

  it("first enable without URL persists default and opts in", () => {
    const doc: Record<string, unknown> = {
      intelligence: { provider: "cli", api_key: null },
    };
    const { next, written } = patchConfigDocument(doc, { httpExtract: true });
    const intel = next.intelligence as {
      http?: { base_url?: string };
      stages?: { extract?: { provider?: string; on_fail?: string } };
    };
    expect(intel.http?.base_url).toBe(HTTP_DEFAULT_BASE_URL);
    expect(intel.stages?.extract).toEqual({ provider: "http", on_fail: "cli" });
    expect(written).toContain("intelligence.http.base_url");
    expect(written).toContain("intelligence.stages.extract.provider");
    expect(written).toContain("intelligence.stages.extract.on_fail");
    const merged = mergedIntel(next);
    expect(httpIsOptedIn(merged.intelligence)).toBe(true);
    expect(resolveStageProviderType(merged.intelligence, "extract", {})).toBe(
      "http",
    );
  });

  it("keep-on omitted map is identity, including under FACTMEM_PROVIDER=heuristic", () => {
    const prev = process.env.FACTMEM_PROVIDER;
    process.env.FACTMEM_PROVIDER = "heuristic";
    try {
      for (const stages of [undefined, {}]) {
        const doc: Record<string, unknown> = {
          intelligence: {
            http: { model: "qwen2.5vl:7b" },
            ...(stages ? { stages } : {}),
          },
        };
        const { next, written } = patchConfigDocument(doc, { httpExtract: true });
        expect(written).toEqual([]);
        expect((next.intelligence as { stages?: unknown }).stages).toEqual(
          stages,
        );
        expect(JSON.stringify(next)).toBe(JSON.stringify(doc));
      }
    } finally {
      if (prev === undefined) delete process.env.FACTMEM_PROVIDER;
      else process.env.FACTMEM_PROVIDER = prev;
    }
  });

  it("keep-on omitted map plus on_fail materialises DEFAULT_HTTP_STAGES", () => {
    const doc: Record<string, unknown> = {
      intelligence: { http: { model: "qwen2.5vl:7b" } },
    };
    const { next } = patchConfigDocument(doc, {
      httpExtract: true,
      httpExtractOnFail: "none",
    });
    const stages = (next.intelligence as {
      stages: Record<string, { provider: string; on_fail?: string }>;
    }).stages;
    expect(stages.extract).toEqual({ provider: "http", on_fail: "none" });
    expect(stages.summarise.provider).toBe("http");
    expect(stages.reconcile.provider).toBe("cli");
    expect(stages.supersede.provider).toBe("cli");
    const merged = mergedIntel(next);
    expect(resolveStageProviderType(merged.intelligence, "summarise", {})).toBe(
      "http",
    );
  });

  it("keep-on omitted map writes URL only and leaves stages omitted", () => {
    const doc: Record<string, unknown> = {
      intelligence: { http: { model: "qwen2.5vl:7b" } },
    };
    const { next, written } = patchConfigDocument(doc, {
      httpExtract: true,
      httpBaseUrl: "http://localhost:1234/v1",
    });
    expect(written).toEqual(["intelligence.http.base_url"]);
    expect((next.intelligence as { stages?: unknown }).stages).toBeUndefined();
    expect(
      (next.intelligence as { http: { base_url: string } }).http.base_url,
    ).toBe("http://localhost:1234/v1");
  });

  it("listed extract on_fail none survives omitted overlay key", () => {
    const doc: Record<string, unknown> = {
      intelligence: {
        http: { model: "qwen2.5vl:7b" },
        stages: { extract: { provider: "http", on_fail: "none" } },
      },
    };
    const { next } = patchConfigDocument(doc, { httpExtract: true });
    expect(
      (next.intelligence as { stages: { extract: { on_fail: string } } }).stages
        .extract.on_fail,
    ).toBe("none");
  });

  it("disable listed extract http leaves other stages and http", () => {
    const doc: Record<string, unknown> = {
      intelligence: {
        http: { base_url: "http://localhost:1234/v1", model: "qwen2.5vl:7b" },
        stages: {
          extract: { provider: "http", on_fail: "cli" },
          summarise: { provider: "http" },
        },
      },
    };
    const { next } = patchConfigDocument(doc, { httpExtract: false });
    const intel = next.intelligence as {
      http: { base_url: string };
      stages: { extract: { provider: string }; summarise: { provider: string } };
    };
    expect(intel.http.base_url).toBe("http://localhost:1234/v1");
    expect(intel.stages.extract.provider).toBe("cli");
    expect(intel.stages.summarise.provider).toBe("http");
  });

  it("disable omitted-map HTTP materialises DEFAULT_HTTP_STAGES except extract", () => {
    const doc: Record<string, unknown> = {
      intelligence: { http: { model: "qwen2.5vl:7b" } },
    };
    const { next } = patchConfigDocument(doc, { httpExtract: false });
    const stages = (next.intelligence as { stages: Record<string, { provider: string }> })
      .stages;
    expect(stages.extract.provider).toBe("cli");
    expect(stages.summarise.provider).toBe(DEFAULT_HTTP_STAGES.summarise);
    expect(stages.reconcile.provider).toBe(DEFAULT_HTTP_STAGES.reconcile);
    expect(stages.supersede.provider).toBe(DEFAULT_HTTP_STAGES.supersede);
    const merged = mergedIntel(next);
    expect(resolveStageProviderType(merged.intelligence, "extract", {})).toBe(
      "cli",
    );
    expect(resolveStageProviderType(merged.intelligence, "summarise", {})).toBe(
      "http",
    );
  });

  it("disable provider http omitted map materialises, not a no-op", () => {
    const doc: Record<string, unknown> = {
      intelligence: { provider: "http" },
    };
    const { next, written } = patchConfigDocument(doc, { httpExtract: false });
    expect(written.length).toBeGreaterThan(0);
    const stages = (next.intelligence as { stages: Record<string, { provider: string }> })
      .stages;
    expect(stages.extract.provider).toBe("cli");
    expect(stages.summarise.provider).toBe("http");
    expect((next.intelligence as { provider: string }).provider).toBe("http");
  });
});

describe("applyInitOverlay defaults mode", () => {
  it("first enable without URL persists the default host", () => {
    const next = applyInitOverlay(defaultServerConfig(), { httpExtract: true });
    expect(next.intelligence.http?.base_url).toBe(HTTP_DEFAULT_BASE_URL);
    expect(next.intelligence.stages?.extract).toEqual({
      provider: "http",
      on_fail: "cli",
    });
    expect(httpIsOptedIn(next.intelligence)).toBe(true);
  });

  it("still calls the shared helper (empty overlay is identity)", () => {
    const { written } = applyMoreOverlayToIntelligence(
      defaultServerConfig().intelligence as unknown as Record<string, unknown>,
      {},
      "defaults",
    );
    expect(written).toEqual([]);
  });
});
