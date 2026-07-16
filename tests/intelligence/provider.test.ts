import { describe, it, expect } from "vitest";
import {
  resolveProviderType,
  createIntelligenceProvider,
  PROVIDER_ENV_VAR,
} from "../../src/intelligence/provider.js";
import type { IntelligenceConfig } from "../../src/types/config.js";

const baseConfig: IntelligenceConfig = {
  provider: "cli",
  fallback: "heuristic",
  api_key: null,
};

describe("resolveProviderType — env kill-switch", () => {
  it("returns the configured provider when no env override is set", () => {
    expect(resolveProviderType("cli", {})).toBe("cli");
    expect(resolveProviderType("sampling", {})).toBe("sampling");
  });

  it("lets OPENMEMORY_PROVIDER override the configured provider", () => {
    expect(resolveProviderType("cli", { [PROVIDER_ENV_VAR]: "heuristic" })).toBe(
      "heuristic",
    );
  });

  it("is case-insensitive and trims whitespace on the override", () => {
    expect(resolveProviderType("cli", { [PROVIDER_ENV_VAR]: "  HEURISTIC " })).toBe(
      "heuristic",
    );
  });

  it("ignores an invalid override and keeps the configured provider", () => {
    expect(resolveProviderType("cli", { [PROVIDER_ENV_VAR]: "bogus" })).toBe("cli");
    expect(resolveProviderType("cli", { [PROVIDER_ENV_VAR]: "" })).toBe("cli");
  });
});

describe("createIntelligenceProvider — selection", () => {
  it("returns a provider exposing the full IntelligenceProvider surface for each type", () => {
    const methods = [
      "classifyFacts",
      "extractEntities",
      "extractFactsFromEvents",
      "detectSupersession",
      "reconcile",
      "summarise",
    ] as const;
    for (const provider of [
      createIntelligenceProvider({ ...baseConfig, provider: "cli" }),
      createIntelligenceProvider({ ...baseConfig, provider: "heuristic" }),
      createIntelligenceProvider({ ...baseConfig, provider: "sampling" }),
      createIntelligenceProvider({ ...baseConfig, provider: "api" }),
    ]) {
      for (const m of methods) {
        expect(typeof (provider as Record<string, unknown>)[m]).toBe("function");
      }
    }
  });

  it("degrades 'sampling' to the heuristic instance when no server is present", () => {
    const heuristic = createIntelligenceProvider({ ...baseConfig, provider: "heuristic" });
    const selected = createIntelligenceProvider(
      { ...baseConfig, provider: "sampling" },
      { heuristic, server: null },
    );
    expect(selected).toBe(heuristic);
  });

  it("degrades the unimplemented 'api' provider to the heuristic instance", () => {
    const heuristic = createIntelligenceProvider({ ...baseConfig, provider: "heuristic" });
    const selected = createIntelligenceProvider(
      { ...baseConfig, provider: "api" },
      { heuristic },
    );
    expect(selected).toBe(heuristic);
  });

  it("honours the env kill-switch — cli config + env=heuristic returns heuristic", () => {
    const heuristic = createIntelligenceProvider({ ...baseConfig, provider: "heuristic" });
    const selected = createIntelligenceProvider(
      { ...baseConfig, provider: "cli" },
      { heuristic, env: { [PROVIDER_ENV_VAR]: "heuristic" } },
    );
    expect(selected).toBe(heuristic);
  });
});
