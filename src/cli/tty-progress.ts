/**
 * One TTY progress line plus idle heartbeat. No bytes when json.
 */

import { EXTRACT_IDLE_HEARTBEAT_MS } from "../types/config.js";
import { INIT_PROMPTS } from "./init-knobs.js";
import { ChunkEta } from "./eta.js";

export function createTtyProgress(opts: { json?: boolean } = {}): {
  onExtractProgress: (done: number, total: number) => void;
  onModelChunk: (lines: number, durationMs: number) => void;
  onIntegrateStart: (pendingI: number) => void;
  onIntegrateProgress: (done: number, total: number) => void;
  stop: () => void;
} {
  const eta = new ChunkEta();
  let last = "";
  let phase: "extract" | "integrate" = "extract";
  let lastDone = 0;
  let lastTotal = 0;
  let idle: ReturnType<typeof setInterval> | undefined;

  const rewrite = (line: string) => {
    if (opts.json) return;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${line.padEnd(Math.max(last.length, line.length))}`);
      last = line;
    } else {
      process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
    }
  };

  const armIdle = () => {
    if (opts.json || idle) return;
    idle = setInterval(() => {
      rewrite(last || INIT_PROMPTS.extractIdle);
    }, EXTRACT_IDLE_HEARTBEAT_MS);
  };

  const clearIdle = () => {
    if (idle) {
      clearInterval(idle);
      idle = undefined;
    }
  };

  const finishLine = () => {
    if (opts.json) return;
    if (process.stdout.isTTY && last) process.stdout.write("\n");
    last = "";
  };

  return {
    onExtractProgress(done, total) {
      phase = "extract";
      lastDone = done;
      lastTotal = total;
      clearIdle();
      rewrite(INIT_PROMPTS.extractProgress(done, total, eta.etaMs(total - done)));
      armIdle();
    },
    onModelChunk(lines, durationMs) {
      eta.noteModelChunk(durationMs, lines);
      if (phase === "extract" && lastTotal > 0) {
        rewrite(
          INIT_PROMPTS.extractProgress(
            lastDone,
            lastTotal,
            eta.etaMs(lastTotal - lastDone),
          ),
        );
      }
    },
    onIntegrateStart(pendingI) {
      finishLine();
      eta.reset();
      phase = "integrate";
      lastDone = 0;
      lastTotal = pendingI;
      if (!opts.json) {
        process.stdout.write(`${INIT_PROMPTS.integratingNow(pendingI)}\n`);
      }
      clearIdle();
      armIdle();
    },
    onIntegrateProgress(done, total) {
      lastDone = done;
      lastTotal = total;
      clearIdle();
      rewrite(INIT_PROMPTS.extractProgress(done, total, eta.etaMs(total - done)));
      armIdle();
    },
    stop() {
      clearIdle();
      finishLine();
    },
  };
}
