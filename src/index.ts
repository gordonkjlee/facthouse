#!/usr/bin/env node

/**
 * Thin loader so `suppress-sqlite-warning` evaluates before `node:sqlite` is
 * even translated. See src/cli/index.ts.
 */
import "./suppress-sqlite-warning.js";
await import("./server.js");
