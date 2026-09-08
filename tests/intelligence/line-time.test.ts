import { describe, it, expect } from "vitest";
import { SOURCE_MTIME_META, lineTimeMs } from "../../src/intelligence/line-time.js";

describe("lineTimeMs", () => {
  it("prefers occurred_at over file mtime and copy time", () => {
    const said = Date.parse("2024-01-15T00:00:00.000Z");
    expect(
      lineTimeMs({
        occurred_at: "2024-01-15T00:00:00.000Z",
        created_at: "2026-09-08T00:00:00.000Z",
        metadata: { [SOURCE_MTIME_META]: "2026-09-01T00:00:00.000Z" },
      }),
    ).toBe(said);
  });

  it("uses Cursor file mtime when said-at is missing", () => {
    const touch = Date.parse("2026-09-01T12:00:00.000Z");
    expect(
      lineTimeMs({
        occurred_at: null,
        created_at: "2026-09-08T00:00:00.000Z",
        metadata: { [SOURCE_MTIME_META]: "2026-09-01T12:00:00.000Z" },
      }),
    ).toBe(touch);
  });

  it("unparseable times are in-window", () => {
    expect(
      lineTimeMs({
        occurred_at: "not-a-date",
        created_at: "also-bad",
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
