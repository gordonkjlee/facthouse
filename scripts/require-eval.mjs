/**
 * Run a required eval and fail if there was nothing to run it against.
 *
 * A wrapper rather than an inline env assignment in package.json, because
 * `VAR=1 vitest` is POSIX syntax that does not work in PowerShell or cmd, and
 * a script that silently does nothing on Windows is the exact failure these
 * evals exist to prevent. Node sets the variable identically everywhere, so no
 * cross-platform env dependency is needed for one line.
 *
 * One file, four names (`first-fact`, `semantic`, `coding-store`,
 * `http-intelligence`). The package.json scripts stay so callers do not grow
 * a second verb.
 */

import { spawn } from "node:child_process";

const EVALS = {
  "first-fact": {
    env: "OPENMEMORY_REQUIRE_FIRST_FACT_EVAL",
    file: "tests/integration/first-fact.test.ts",
  },
  semantic: {
    env: "OPENMEMORY_REQUIRE_SEMANTIC_EVAL",
    file: "tests/integration/semantic-recall.test.ts",
  },
  "coding-store": {
    env: "OPENMEMORY_REQUIRE_CODING_STORE_EVAL",
    file: "tests/integration/coding-store.test.ts",
  },
  "http-intelligence": {
    env: "OPENMEMORY_REQUIRE_HTTP_INTEL_EVAL",
    file: "tests/integration/http-intelligence.test.ts",
  },
};

const name = process.argv[2];
const spec = name ? EVALS[name] : undefined;
if (!spec) {
  const names = Object.keys(EVALS).join("|");
  process.stderr.write(`usage: node scripts/require-eval.mjs <${names}>\n`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    spec.file,
    "--reporter=verbose",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, [spec.env]: "1" },
  },
);

child.on("exit", (code) => process.exit(code ?? 1));
