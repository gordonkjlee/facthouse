/**
 * Run the semantic-recall eval and fail if there was nothing to run it against.
 *
 * A wrapper rather than an inline env assignment in package.json, because
 * `VAR=1 vitest` is POSIX syntax that does not work in PowerShell or cmd, and
 * a script that silently does nothing on Windows is the exact failure this eval
 * exists to prevent. Node sets the variable identically everywhere, so no
 * cross-platform env dependency is needed for one line.
 */

import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/integration/semantic-recall.test.ts",
    "--reporter=verbose",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, OPENMEMORY_REQUIRE_SEMANTIC_EVAL: "1" },
  },
);

child.on("exit", (code) => process.exit(code ?? 1));
