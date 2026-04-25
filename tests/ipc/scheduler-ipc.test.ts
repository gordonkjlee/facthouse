import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  schedulerIpcPath,
  startSchedulerListener,
  sendSchedulerSignal,
  type SchedulerListener,
  type SignalKind,
} from "../../src/ipc/scheduler-ipc.js";

let dir: string;
const listeners: SchedulerListener[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "om-ipc-"));
});

afterEach(() => {
  for (const l of listeners) l.close();
  listeners.length = 0;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("scheduler IPC", () => {
  it("derives a stable path per data dir", () => {
    const a = schedulerIpcPath(dir);
    const b = schedulerIpcPath(dir);
    expect(a).toBe(b);
    const other = schedulerIpcPath(path.join(dir, "sub"));
    expect(other).not.toBe(a);
  });

  it("delivers tick signals from client to server", async () => {
    const received: SignalKind[] = [];
    const listener = await startSchedulerListener(dir, (kind) => {
      received.push(kind);
    });
    listeners.push(listener);
    expect(listener.bound).toBe(true);

    const ok = await sendSchedulerSignal(dir, "tick");
    expect(ok).toBe(true);

    // Give the async data handler a moment to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(["tick"]);
  });

  it("delivers flush signals distinctly from tick signals", async () => {
    const received: SignalKind[] = [];
    const listener = await startSchedulerListener(dir, (kind) => {
      received.push(kind);
    });
    listeners.push(listener);

    await sendSchedulerSignal(dir, "flush");
    await sendSchedulerSignal(dir, "tick");
    await sendSchedulerSignal(dir, "flush");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(["flush", "tick", "flush"]);
  });

  it("handles rapid successive signals without dropping any", async () => {
    const received: SignalKind[] = [];
    const listener = await startSchedulerListener(dir, (kind) => {
      received.push(kind);
    });
    listeners.push(listener);

    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () => sendSchedulerSignal(dir, "tick")),
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(N);
    expect(received.every((k) => k === "tick")).toBe(true);
  });

  it("sendSchedulerSignal returns false when no server is listening", async () => {
    const ok = await sendSchedulerSignal(dir, "tick", 200);
    expect(ok).toBe(false);
  });

  it("detects a concurrent listener on the same data dir", async () => {
    const first = await startSchedulerListener(dir, () => {});
    listeners.push(first);
    expect(first.bound).toBe(true);

    const second = await startSchedulerListener(dir, () => {});
    listeners.push(second);
    expect(second.bound).toBe(false);
  });

  it("survives an onSignal callback that throws", async () => {
    let callCount = 0;
    const listener = await startSchedulerListener(dir, () => {
      callCount++;
      throw new Error("boom");
    });
    listeners.push(listener);

    await sendSchedulerSignal(dir, "tick");
    await sendSchedulerSignal(dir, "tick");
    await new Promise((r) => setTimeout(r, 50));

    expect(callCount).toBe(2);
    // Listener should still be bound and usable.
    expect(listener.bound).toBe(true);
  });
});
