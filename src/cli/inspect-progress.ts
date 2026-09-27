/**
 * One stderr line for inspect HTML build. Silent when json or non-progress.
 */

import { formatEta } from "./eta.js";

const IDLE_MS = 2000;

export interface InspectProgress {
  phase(label: string): void;
  tick(done: number, total: number, label: string): void;
  stop(): void;
}

export function createInspectProgress(opts: {
  enabled: boolean;
  write?: (s: string) => void;
  isTty?: boolean;
}): InspectProgress {
  if (!opts.enabled) {
    return { phase() {}, tick() {}, stop() {} };
  }
  const write = opts.write ?? ((s) => process.stderr.write(s));
  const isTty = opts.isTty ?? Boolean(process.stderr.isTTY);
  let last = "";
  let idle: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let lastLabel = "";

  const paint = (line: string) => {
    if (isTty) {
      write(`\r${line.padEnd(Math.max(last.length, line.length))}`);
    } else if (line !== last) {
      write(line.endsWith("\n") ? line : `${line}\n`);
    }
    last = line;
  };

  // Heartbeat only paints when the event loop can run (awaited SQL).
  // Tight CPU must call tick(); setInterval will not fire until it yields.
  const armIdle = () => {
    if (idle || !isTty) return;
    idle = setInterval(() => {
      const base = last.trimEnd() || lastLabel;
      paint(`${base.replace(/ — still working…$/, "")} — still working…`);
    }, IDLE_MS);
  };

  const clearIdle = () => {
    if (idle) {
      clearInterval(idle);
      idle = undefined;
    }
  };

  return {
    phase(label: string) {
      clearIdle();
      startedAt = Date.now();
      lastLabel = label;
      paint(label);
      armIdle();
    },
    tick(done: number, total: number, label: string) {
      clearIdle();
      lastLabel = label;
      if (startedAt === 0) startedAt = Date.now();
      let extra = "";
      if (done >= 50 && done < total && startedAt > 0) {
        const elapsed = Date.now() - startedAt;
        const remain = Math.round((elapsed / done) * (total - done));
        extra = `  ~${formatEta(remain)}`;
      }
      paint(`${label}  ${done}/${total}${extra}`);
      armIdle();
    },
    stop() {
      clearIdle();
      if (isTty && last) write("\n");
      last = "";
    },
  };
}
