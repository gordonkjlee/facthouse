#!/usr/bin/env node

/**
 * Thin loader so `suppress-sqlite-warning` evaluates before `node:sqlite` is
 * even translated. A static import of sqlite in this file (via the rest of
 * the CLI graph) emits ExperimentalWarning during graph load, before any
 * wrap of process.emitWarning can run.
 */
import "../suppress-sqlite-warning.js";
await import("./run.js");
