/**
 * Cross-process IPC for scheduler wake-up.
 *
 * The MCP server holds a listener on a Unix domain socket (or Windows named
 * pipe). The log-event CLI — running in a separate short-lived process
 * spawned by a hook — connects, writes one byte indicating the kind of
 * signal, and closes. The server's listener decodes the byte and calls
 * onSignal('tick') or onSignal('flush').
 *
 * Protocol:
 *   't' (0x74) → tick  — threshold check, skip if delta below threshold
 *   'f' (0x66) → flush — force a consolidation regardless of delta
 *
 * Path format:
 *   Unix:    <dataDir>/.scheduler.sock
 *   Windows: \\.\pipe\openmemory-<sha1(dataDir).slice(0,16)>  (kernel-managed)
 *
 * Why these specifically:
 *   - Unix sockets are cleaned up on normal shutdown; on crash the file
 *     remains. We handle that via test-then-bind in startSchedulerListener.
 *   - Windows named pipes are kernel-managed — they disappear with the
 *     process, no stale artifacts to clean up.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// Probed on Windows and verified: ENOENT = no listener, EADDRINUSE = live listener.
// See plan's Phase 0 results. Unix socket stale handling is test-then-bind below.

export type SignalKind = "tick" | "flush";

export interface SchedulerListener {
  /** Stop accepting new connections and release the socket/pipe. */
  close(): void;
  /** True if the listener is bound (i.e. this process owns the pipe). */
  readonly bound: boolean;
}

/** Compute the platform-appropriate IPC path for a data directory. */
export function schedulerIpcPath(dataDir: string): string {
  if (process.platform === "win32") {
    // Named pipe names have length limits and can't contain full filesystem
    // paths. Hash the dataDir to get a short, stable, unique suffix.
    const hash = createHash("sha1")
      .update(path.resolve(dataDir))
      .digest("hex")
      .slice(0, 16);
    return String.raw`\\.\pipe\openmemory-${hash}`;
  }
  return path.join(dataDir, ".scheduler.sock");
}

/** Encode a signal kind into its wire byte. */
function encodeSignal(kind: SignalKind): string {
  return kind === "flush" ? "f" : "t";
}

/** Decode a received byte into a signal kind, or null if unrecognised. */
function decodeSignal(byte: number): SignalKind | null {
  if (byte === 0x66) return "flush"; // 'f'
  if (byte === 0x74) return "tick"; // 't'
  return null;
}

/**
 * Detect a stale Unix socket file. Returns true if the file exists but
 * nothing is listening on it (i.e. safe to unlink before binding). On
 * Windows this is never needed — pipes are kernel-managed.
 */
async function probeListener(socketPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(socketPath);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, timeoutMs);
    client.once("connect", () => {
      clearTimeout(timer);
      client.end();
      resolve(true);
    });
    client.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Bind a listener. Handles Unix stale-socket reclaim via test-then-bind:
 * only removes the socket file if probing confirms no one is currently
 * listening. Windows named pipes don't need this — EADDRINUSE only fires
 * when another process actually holds the pipe.
 */
export async function startSchedulerListener(
  dataDir: string,
  onSignal: (kind: SignalKind) => void,
): Promise<SchedulerListener> {
  const socketPath = schedulerIpcPath(dataDir);
  const isUnix = process.platform !== "win32";

  const server: Server = createServer((socket: Socket) => {
    socket.once("data", (chunk: Buffer | string) => {
      const byte = typeof chunk === "string" ? chunk.charCodeAt(0) : chunk[0];
      const kind = decodeSignal(byte);
      if (kind !== null) {
        try {
          onSignal(kind);
        } catch {
          // onSignal must never throw into the listener. Swallow and move on.
        }
      }
      socket.end();
    });
    // Guard against clients that connect and never send.
    socket.setTimeout(1000);
    socket.once("timeout", () => socket.destroy());
    socket.once("error", () => socket.destroy());
  });

  const tryListen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });

  try {
    await tryListen();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") throw err;

    if (isUnix) {
      // Probe — if anyone's listening we give up; if not, the socket file
      // is stale and safe to unlink.
      const alive = await probeListener(socketPath);
      if (alive) {
        return { close: () => {}, bound: false };
      }
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore — next listen() will surface a meaningful error */
      }
      await tryListen();
    } else {
      // Windows: EADDRINUSE means another process holds the pipe. Nothing
      // to clean up; this server won't be the signal handler.
      return { close: () => {}, bound: false };
    }
  }

  server.unref();

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      server.close();
      if (isUnix) {
        try {
          unlinkSync(socketPath);
        } catch {
          /* ignore */
        }
      }
    },
    get bound() {
      return !closed;
    },
  };
}

/**
 * Send a signal to the running MCP server. Resolves with true if the
 * server acknowledged receipt (connection succeeded and we wrote our byte),
 * false on any failure. Never throws.
 */
export function sendSchedulerSignal(
  dataDir: string,
  kind: SignalKind,
  timeoutMs = 500,
): Promise<boolean> {
  const socketPath = schedulerIpcPath(dataDir);
  return new Promise((resolve) => {
    const client = createConnection(socketPath);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      client.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    client.once("connect", () => {
      client.write(encodeSignal(kind), () => {
        client.end();
      });
    });
    client.once("end", () => {
      clearTimeout(timer);
      finish(true);
    });
    client.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}
