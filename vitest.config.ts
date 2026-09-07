import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // GitHub Windows runners often spend more than vitest's 5s default on
    // CLI-spawn tests (init + log-event). The assertions still catch hangs;
    // 20s is a wall-clock budget, not a latency claim.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
    // beforeEach/afterEach open and delete file-backed SQLite. Vitest's 10s
    // default is a load detector on a contended Windows runner (applySchema +
    // rmSync of WAL files), not a hang detector. 20s still fails a stuck close.
    hookTimeout: process.platform === "win32" ? 20_000 : 10_000,
  },
});
