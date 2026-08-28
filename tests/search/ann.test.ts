import { describe, it, expect } from "vitest";
import {
  shouldUseAnn,
  wouldWantAnn,
  embeddingWorkingSetBytes,
  postgresHnswFallbackWarning,
  sqliteEngineMissingWarning,
} from "../../src/search/ann.js";
import { ANN_DEFAULT_MAX_BYTES } from "../../src/types/config.js";

describe("shouldUseAnn", () => {
  it("auto stays exact when the working set is small", () => {
    for (const dialect of ["sqlite", "postgres"] as const) {
      expect(
        shouldUseAnn({
          dialect,
          ann: null,
          bytes: 8 * 1024 * 1024,
          maxBytes: ANN_DEFAULT_MAX_BYTES,
          enginePresent: true,
        }),
      ).toBe(false);
    }
  });

  it("auto uses HNSW over the byte threshold when the engine is present", () => {
    for (const dialect of ["sqlite", "postgres"] as const) {
      expect(
        shouldUseAnn({
          dialect,
          ann: null,
          bytes: ANN_DEFAULT_MAX_BYTES + 1,
          maxBytes: ANN_DEFAULT_MAX_BYTES,
          enginePresent: true,
        }),
      ).toBe(true);
      expect(
        shouldUseAnn({
          dialect,
          ann: null,
          bytes: ANN_DEFAULT_MAX_BYTES + 1,
          maxBytes: ANN_DEFAULT_MAX_BYTES,
          enginePresent: false,
        }),
      ).toBe(false);
    }
  });

  it("ann false never uses HNSW", () => {
    for (const dialect of ["sqlite", "postgres"] as const) {
      expect(
        shouldUseAnn({
          dialect,
          ann: false,
          bytes: ANN_DEFAULT_MAX_BYTES * 2,
          maxBytes: ANN_DEFAULT_MAX_BYTES,
          enginePresent: true,
        }),
      ).toBe(false);
    }
  });

  it("ann true uses HNSW even when small, if the engine is present", () => {
    for (const dialect of ["sqlite", "postgres"] as const) {
      expect(
        shouldUseAnn({
          dialect,
          ann: true,
          bytes: 8,
          maxBytes: ANN_DEFAULT_MAX_BYTES,
          enginePresent: true,
        }),
      ).toBe(true);
      expect(
        shouldUseAnn({
          dialect,
          ann: true,
          bytes: 8,
          maxBytes: ANN_DEFAULT_MAX_BYTES,
          enginePresent: false,
        }),
      ).toBe(false);
    }
  });
});

describe("wouldWantAnn", () => {
  it("is true on either dialect when auto and over the byte threshold", () => {
    expect(
      wouldWantAnn({
        dialect: "postgres",
        ann: null,
        bytes: ANN_DEFAULT_MAX_BYTES + 1,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
      }),
    ).toBe(true);
    expect(
      wouldWantAnn({
        dialect: "sqlite",
        ann: null,
        bytes: ANN_DEFAULT_MAX_BYTES + 1,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
      }),
    ).toBe(true);
  });
});

describe("postgresHnswFallbackWarning", () => {
  it("names the driver error and the exact scan", () => {
    expect(postgresHnswFallbackWarning("index is invalid")).toMatch(/index is invalid/);
    expect(postgresHnswFallbackWarning("index is invalid")).toMatch(/exact scan/);
  });
});

describe("sqliteEngineMissingWarning", () => {
  it("says meaning-search is still exact and does not name Postgres as the only scale path", () => {
    expect(sqliteEngineMissingWarning()).toMatch(/still exact/);
    expect(sqliteEngineMissingWarning()).not.toMatch(/Postgres is the scale path/);
  });
});

describe("embeddingWorkingSetBytes", () => {
  it("is count × dimensions × 4", () => {
    expect(embeddingWorkingSetBytes(8192, 1024)).toBe(ANN_DEFAULT_MAX_BYTES);
    expect(embeddingWorkingSetBytes(4000, 512)).toBe(8_192_000);
  });
});
