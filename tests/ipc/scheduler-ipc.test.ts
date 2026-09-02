import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  schedulerIpcPath,
  startNotifyListener,
  notifyServer,
  isServerListening,
  type NotifyListener,
} from "../../src/ipc/scheduler-ipc.js";
import type { NotifiableMoment } from "../../src/intelligence/steps.js";

let dir: string;
const listeners: NotifyListener[] = [];

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

describe("notify IPC", () => {
  it("derives a stable path per data dir", () => {
    const a = schedulerIpcPath(dir);
    const b = schedulerIpcPath(dir);
    expect(a).toBe(b);
    const other = schedulerIpcPath(path.join(dir, "sub"));
    expect(other).not.toBe(a);
  });

  it("delivers a threshold moment from client to server", async () => {
    const received: NotifiableMoment[] = [];
    const listener = await startNotifyListener(dir, (moment) => {
      received.push(moment);
    });
    listeners.push(listener);
    expect(listener.bound).toBe(true);

    const ok = await notifyServer(dir, "threshold");
    expect(ok).toBe(true);

    // Give the async data handler a moment to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(["threshold"]);
  });

  it("delivers compaction distinctly from threshold", async () => {
    const received: NotifiableMoment[] = [];
    const listener = await startNotifyListener(dir, (moment) => {
      received.push(moment);
    });
    listeners.push(listener);

    await notifyServer(dir, "compaction");
    await notifyServer(dir, "threshold");
    await notifyServer(dir, "compaction");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(["compaction", "threshold", "compaction"]);
  });

  it("handles rapid successive moments without dropping any", async () => {
    const received: NotifiableMoment[] = [];
    const listener = await startNotifyListener(dir, (moment) => {
      received.push(moment);
    });
    listeners.push(listener);

    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () => notifyServer(dir, "threshold")),
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(N);
    expect(received.every((m) => m === "threshold")).toBe(true);
  });

  it("notifyServer returns false when no server is listening", async () => {
    const ok = await notifyServer(dir, "threshold", 200);
    expect(ok).toBe(false);
  });

  it("isServerListening probes without delivering a moment", async () => {
    expect(await isServerListening(dir)).toBe(false);
    const received: NotifiableMoment[] = [];
    const listener = await startNotifyListener(dir, (moment) => {
      received.push(moment);
    });
    listeners.push(listener);
    expect(await isServerListening(dir)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([]);
  });

  it("detects a concurrent listener on the same data dir", async () => {
    const first = await startNotifyListener(dir, () => {});
    listeners.push(first);
    expect(first.bound).toBe(true);

    const second = await startNotifyListener(dir, () => {});
    listeners.push(second);
    expect(second.bound).toBe(false);
  });

  it("survives an onMoment callback that throws", async () => {
    let callCount = 0;
    const listener = await startNotifyListener(dir, () => {
      callCount++;
      throw new Error("boom");
    });
    listeners.push(listener);

    await notifyServer(dir, "threshold");
    await notifyServer(dir, "threshold");
    await new Promise((r) => setTimeout(r, 50));

    expect(callCount).toBe(2);
    // Listener should still be bound and usable.
    expect(listener.bound).toBe(true);
  });
});
