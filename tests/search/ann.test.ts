import { describe, it, expect } from "vitest";
import {
  shouldUseAnn,
  wouldWantAnn,
  embeddingWorkingSetBytes,
  postgresHnswFallbackWarning,
} from "../../src/search/ann.js";
import { ANN_DEFAULT_MAX_BYTES } from "../../src/types/config.js";

describe("shouldUseAnn", () => {
  it("never uses HNSW on sqlite", () => {
    expect(
      shouldUseAnn({
        dialect: "sqlite",
        ann: true,
        bytes: ANN_DEFAULT_MAX_BYTES * 2,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
        extensionPresent: true,
      }),
    ).toBe(false);
  });

  it("auto stays exact when the working set is small", () => {
    expect(
      shouldUseAnn({
        dialect: "postgres",
        ann: null,
        bytes: 8 * 1024 * 1024,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
        extensionPresent: true,
      }),
    ).toBe(false);
  });

  it("auto uses HNSW over the byte threshold when the extension is present", () => {
    expect(
      shouldUseAnn({
        dialect: "postgres",
        ann: null,
        bytes: ANN_DEFAULT_MAX_BYTES + 1,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
        extensionPresent: true,
      }),
    ).toBe(true);
    expect(
      shouldUseAnn({
        dialect: "postgres",
        ann: null,
        bytes: ANN_DEFAULT_MAX_BYTES + 1,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
        extensionPresent: false,
      }),
    ).toBe(false);
  });

  it("ann false never uses HNSW", () => {
    expect(
      shouldUseAnn({
        dialect: "postgres",
        ann: false,
        bytes: ANN_DEFAULT_MAX_BYTES * 2,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
        extensionPresent: true,
      }),
    ).toBe(false);
  });

  it("ann true uses HNSW even when small, if the extension is present", () => {
    expect(
      shouldUseAnn({
        dialect: "postgres",
        ann: true,
        bytes: 8,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
        extensionPresent: true,
      }),
    ).toBe(true);
    expect(
      shouldUseAnn({
        dialect: "postgres",
        ann: true,
        bytes: 8,
        maxBytes: ANN_DEFAULT_MAX_BYTES,
        extensionPresent: false,
      }),
    ).toBe(false);
  });
});

describe("wouldWantAnn", () => {
  it("is true when postgres would use HNSW except for a missing extension", () => {
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
    ).toBe(false);
  });
});

describe("postgresHnswFallbackWarning", () => {
  it("names the driver error and the exact scan", () => {
    expect(postgresHnswFallbackWarning("index is invalid")).toMatch(/index is invalid/);
    expect(postgresHnswFallbackWarning("index is invalid")).toMatch(/exact scan/);
  });
});

describe("embeddingWorkingSetBytes", () => {
  it("is count × dimensions × 4", () => {
    expect(embeddingWorkingSetBytes(8192, 1024)).toBe(ANN_DEFAULT_MAX_BYTES);
    expect(embeddingWorkingSetBytes(4000, 512)).toBe(8_192_000);
  });
});
