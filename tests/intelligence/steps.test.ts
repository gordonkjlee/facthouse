/**
 * The vocabulary table. Copy, extract, integrate; consolidate; moments.
 * One definition, so these tests pin the public meaning of each flag and
 * each moment rather than re-deriving it in three places.
 */

import { describe, it, expect } from "vitest";
import {
  ALL_STEPS,
  EXTRACT_CAP_EVENTS,
  MOMENTS,
  MOMENT_POLICY,
  NOTIFIABLE_MOMENTS,
  isMoment,
  isNotifiableMoment,
  pipelineWhenMarkdown,
  stepsFromFlags,
} from "../../src/intelligence/steps.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { THRESHOLD_MIN_INTERVAL_MS } from "../../src/scheduler.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("stepsFromFlags", () => {
  it("no flags means every step", () => {
    expect(stepsFromFlags({})).toEqual({ copy: true, extract: true, integrate: true });
    expect(stepsFromFlags({ copy: false, extract: false, integrate: false })).toEqual(
      ALL_STEPS,
    );
  });

  it("named steps run and unnamed steps are skipped", () => {
    expect(stepsFromFlags({ copy: true })).toEqual({
      copy: true,
      extract: false,
      integrate: false,
    });
    expect(stepsFromFlags({ integrate: true })).toEqual({
      copy: false,
      extract: false,
      integrate: true,
    });
    expect(stepsFromFlags({ copy: true, extract: true })).toEqual({
      copy: true,
      extract: true,
      integrate: false,
    });
  });

  it("returns a fresh object, never the frozen ALL_STEPS", () => {
    const steps = stepsFromFlags({});
    expect(steps).not.toBe(ALL_STEPS);
    steps.copy = false;
    expect(ALL_STEPS.copy).toBe(true);
  });
});

describe("moments", () => {
  it("are the consolidation.triggers vocabulary", () => {
    expect([...MOMENTS]).toEqual([
      "session_start",
      "threshold",
      "compaction",
      "shutdown",
      "manual",
    ]);
    for (const m of MOMENTS) expect(isMoment(m)).toBe(true);
    expect(isMoment("tick")).toBe(false);
    expect(isMoment("flush")).toBe(false);
  });

  it("only threshold and compaction can be sent from another process", () => {
    expect([...NOTIFIABLE_MOMENTS]).toEqual(["threshold", "compaction"]);
    expect(isNotifiableMoment("compaction")).toBe(true);
    expect(isNotifiableMoment("shutdown")).toBe(false);
    expect(isNotifiableMoment("manual")).toBe(false);
  });

  it("threshold is the only gated moment and the only extract-only one", () => {
    expect(MOMENT_POLICY.threshold).toEqual({
      steps: { copy: false, extract: true, integrate: false },
      force: false,
    });
    for (const m of MOMENTS) {
      if (m === "threshold") continue;
      expect(MOMENT_POLICY[m].force).toBe(true);
    }
  });

  it("compaction runs everything; shutdown integrates only", () => {
    expect(MOMENT_POLICY.compaction.steps).toEqual(ALL_STEPS);
    expect(MOMENT_POLICY.session_start.steps).toEqual(ALL_STEPS);
    expect(MOMENT_POLICY.manual.steps).toEqual(ALL_STEPS);
    expect(MOMENT_POLICY.shutdown.steps).toEqual({
      copy: false,
      extract: false,
      integrate: true,
    });
  });

  it("the extract cap is the documented 50 lines", () => {
    expect(EXTRACT_CAP_EVENTS).toBe(50);
  });

  it("the public when-table is MOMENT_POLICY plus read-time copy", () => {
    const table = pipelineWhenMarkdown();
    const cap = `cap ${EXTRACT_CAP_EVENTS}`;
    expect(table).toContain("**Automatic**");
    expect(table).toContain("**Callable**");
    expect(table).toContain("| Facthouse MCP server starts | yes |");
    expect(table).toContain(
      "| A Facthouse tool or resource is called | yes, if sources named and JSONL grew | no | no |",
    );
    expect(table).toContain("| Facthouse MCP process exits | no | no | yes |");
    expect(table).toContain("`consolidate`");
    expect(table).toContain("Caller waits.");
    expect(table).toContain("recommended PreCompact; we do not install");
    expect(table).not.toContain("`record`");
    expect(table).toContain(
      `| \`facthouse notify threshold\` | Other process. Does not wait. Not a copy-store hook. | no | yes, if due (${cap}) | no |`,
    );
    expect(MOMENT_POLICY.session_start.steps).toEqual(ALL_STEPS);
    expect(MOMENT_POLICY.manual.steps).toEqual(MOMENT_POLICY.compaction.steps);
  });
});

describe("public when-table", () => {
  it("README includes the generated grid and the due-rule numbers", () => {
    const readme = readFileSync(
      path.resolve(fileURLToPath(new URL("../../README.md", import.meta.url))),
      "utf-8",
    ).replace(/\r\n/g, "\n");
    expect(readme).toContain(pipelineWhenMarkdown());
    expect(readme).toContain(
      `${DEFAULT_CONFIG.consolidation.threshold} unexamined lines`,
    );
    expect(THRESHOLD_MIN_INTERVAL_MS).toBe(120_000);
    expect(readme).toContain("two minutes");
    expect(readme).toContain("same three steps as `consolidate`");
  });
});
