#!/usr/bin/env node

import "../suppress-sqlite-warning.js";

/**
 * Facthouse CLI entry point.
 *
 * Public verbs: init, settings, record, notify, consolidate, search, stats,
 * inspect, prune. The 0.25 verbs `pull`, `signal`, and `log-event` are gone;
 * they print usage and exit 1. The vocabulary (copy, extract, integrate;
 * consolidate; moments) is defined once in src/intelligence/steps.ts.
 */

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { recordEvent, extractContentFromHookPayload } from "./record.js";
import {
  initDataDir,
  mcpConfigSnippet,
  mcpServerName,
  mcpSnippetDataDir,
  providerStatusLines,
  embeddingStatusLines,
  appendCaptureRecipe,
} from "./init.js";
import {
  collectInitAnswers,
  isInteractiveInit,
  bindInitIo,
  silentInitIo,
  defaultInitWizardDeps,
  type InitWizardSeed,
  type InitWizardResult,
} from "./init-wizard.js";
import { INIT_PROMPTS } from "./init-knobs.js";
import {
  offerInitBackfill,
  shouldOfferInitBackfill,
} from "./init-backfill.js";
import { runSettings } from "./settings.js";
import { collectInitWebAnswers } from "./web.js";
import {
  CLI_NAME,
  PRODUCT_NAME,
  cliDataArg,
  envIsSet,
  envValue,
  npmPackageSpec,
} from "../identity.js";
import { dataDirFromEnvOrDefault, resolveUserPath } from "../paths.js";
import {
  runSearch,
  formatSearch,
  formatStats,
  formatPrune,
  formatConsolidate,
  getStats,
} from "./query.js";
import { packageVersion } from "./package-version.js";
import { runInspect } from "./inspect.js";
import { prunableEvents, pruneEvents, vacuum } from "../db/prune.js";
import { applySqliteDiskBudget, getBoundDiskBudget } from "../db/disk-budget.js";
import { closeDatabase, type Db } from "../db/connection.js";
import { applySchema } from "../db/schema.js";
import { openStore, sqliteMemoryPath } from "../db/store.js";
import { consolidate, type ConsolidationResult } from "../intelligence/consolidate.js";
import {
  ALL_STEPS,
  NOTIFIABLE_MOMENTS,
  isNotifiableMoment,
  stepsFromFlags,
  type ConsolidateSteps,
  type NotifiableMoment,
} from "../intelligence/steps.js";
import { createIntelligenceProvider, resolveProviderType } from "../intelligence/provider.js";
import { createHeuristicProvider } from "../intelligence/heuristic.js";
import { probeHttpModels } from "../intelligence/http.js";
import { loadStoreVocabulary } from "../db/domains.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import type { IntelligenceProvider } from "../intelligence/types.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import { DEFAULT_CONFIG, type ServerConfig } from "../types/config.js";
import type { SessionEvent } from "../types/data.js";
import {
  CONFIG_FILENAME,
  loadConfig,
  loadShippedStoreConfig,
  configuredStorageProvider,
  ensureBitemporalSince,
  systemTimeWarning,
} from "../config.js";
import { parseSystemTime } from "../db/facts.js";
import { notifyServer, isServerListening } from "../ipc/scheduler-ipc.js";
import { copySources } from "../sources/copy.js";
import { unexaminedEventCount } from "../db/extract-watermarks.js";

const SESSION_ROLES = ["user", "assistant", "system", "tool"] as const;
const SESSION_EVENT_TYPES = ["message", "tool_call", "tool_result", "artifact"] as const;
const SESSION_CONTENT_TYPES = ["text", "json", "image", "audio", "binary"] as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSessionRole(value: string): value is SessionEvent["role"] {
  return (SESSION_ROLES as readonly string[]).includes(value);
}

function isSessionEventType(value: string): value is SessionEvent["event_type"] {
  return (SESSION_EVENT_TYPES as readonly string[]).includes(value);
}

function isSessionContentType(value: string): value is SessionEvent["content_type"] {
  return (SESSION_CONTENT_TYPES as readonly string[]).includes(value);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);

    // Don't hang if stdin is a TTY with no data.
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

async function main() {
  const subcommand = process.argv[2];

  // Recursion guard: any subprocess-based intelligence provider that
  // re-invokes an MCP client should set FACTHOUSE_SUBPROCESS=1 (or the
  // FACTHOUSE_SUBPROCESS compat alias) in the child's env. If a surviving
  // hook then re-enters this CLI, we must not log events, signal the
  // scheduler, or consolidate — each would feed back into an extraction loop.
  // Exit silently with success.
  //
  // `init` is exempt: it only creates a directory, database, and config, so it
  // cannot recurse. Skipping it here would make an explicit setup command exit
  // 0 having silently done nothing — a confusing failure with no diagnostic.
  if (envIsSet("SUBPROCESS", "1") && subcommand !== "init") {
    process.exit(0);
  }

  if (
    subcommand === undefined ||
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === "help"
  ) {
    console.log(usageText());
    process.exit(0);
  }

  if (subcommand === "init") {
    await runInit();
  } else if (subcommand === "settings") {
    await runSettingsCmd();
  } else if (subcommand === "record") {
    await runRecord();
  } else if (subcommand === "notify") {
    await runNotify();
  } else if (subcommand === "consolidate") {
    await runConsolidate();
  } else if (subcommand === "search") {
    await runSearchCmd();
  } else if (subcommand === "stats") {
    await runStatsCmd();
  } else if (subcommand === "inspect") {
    await runInspectCmd();
  } else if (subcommand === "prune") {
    await runPruneCmd();
  } else {
    console.error(usageText());
    process.exit(1);
  }
}

/** One usage block, grouped by job. Hidden aliases are not listed. */
function usageText(): string {
  return [
    `Usage: ${CLI_NAME} <command> [--data <dir>]`,
    ``,
    `Set up`,
    `  init [dir]      Create the store (--yes: no prompts; --web: local page)`,
    `  settings        Change extra knobs on an existing store (--json, --web)`,
    ``,
    `Feed`,
    `  record          Record one session event (used by hooks; reads stdin)`,
    `  notify <moment> Tell the running MCP server a moment happened`,
    `                  (${NOTIFIABLE_MOMENTS.join(", ")})`,
    ``,
    `Consolidate`,
    `  consolidate     Copy, extract, and integrate (spends model calls)`,
    `                  -c --copy  -e --extract  -i --integrate   run only these steps`,
    `                  -a --all   extract every remaining line   -l --limit N  oldest N`,
    ``,
    `Read`,
    `  search <q>      Search integrated knowledge (--domain, --limit, --json)`,
    `  stats           Counts, extract backlog, spend, whether a server is up`,
    `  inspect         Sample D / I / K and write a local HTML graph`,
    ``,
    `Housekeeping`,
    `  prune           Reclaim raw events nothing can reach (dry run by default)`,
    ``,
    `--data defaults to FACTHOUSE_DATA or ~/.facthouse.`,
  ].join("\n");
}

async function runInit() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string" },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", default: false, short: "y" },
      web: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  // Accept `facthouse init ~/.facthouse` (positional) as well as --data, so
  // the documented form and the flag used by every other subcommand both work.
  const target =
    positionals[0] ??
    (values.data as string | undefined) ??
    dataDirFromEnvOrDefault();
  // Normalise to an absolute, platform-native path so every path we print (and
  // embed in the MCP snippet) is consistent regardless of how it was typed.
  const dataDir = resolveUserPath(target);
  const dataDirLocked =
    Boolean(positionals[0] ?? values.data) || Boolean(values.force);
  const seed: InitWizardSeed = {
    dataDir,
    dataDirLocked,
    force: values.force as boolean,
  };
  const seedHasConfig = existsSync(path.join(seed.dataDir, CONFIG_FILENAME));
  const ask = isInteractiveInit({
    stdinIsTTY: Boolean(process.stdin.isTTY),
    yes: Boolean(values.yes),
    seed,
    configExists: seedHasConfig,
  });
  const web = Boolean(values.web);
  const yes = Boolean(values.yes);

  let reportDir = seed.dataDir;
  let result;
  let wizard: InitWizardResult;
  let rl: ReturnType<typeof createInterface> | undefined;
  const onSigint = () => {
    rl?.close();
    process.exit(130);
  };
  try {
    // Always — env postgres refuses before prompts, even with no config.json.
    loadShippedStoreConfig(seed.dataDir);

    if (web && yes) {
      console.error(INIT_PROMPTS.webYesRefuse);
      process.exit(1);
    }

    if (web) {
      wizard = await collectInitWebAnswers(seed, {
        stdout: process.stderr,
        processCwd: process.cwd(),
      });
    } else if (!ask) {
      wizard = await collectInitAnswers(silentInitIo(), seed);
    } else {
      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      rl.on("SIGINT", onSigint);
      wizard = await collectInitAnswers(bindInitIo(rl), seed, {
        ...defaultInitWizardDeps,
        probeHttp: (baseUrl) => probeHttpModels(baseUrl),
      });
    }
    reportDir = wizard.dataDir;
    result = await initDataDir({
      dataDir: wizard.dataDir,
      force: values.force as boolean,
      overlay: wizard.overlay,
    });
  } catch (err: unknown) {
    rl?.close();
    console.error(`Failed to initialise ${reportDir}: ${errorMessage(err)}`);
    process.exit(1);
  }

  const version = packageVersion();
  const spec = npmPackageSpec(version);

  const snippet = mcpConfigSnippet(
    spec,
    mcpSnippetDataDir(result.dataDir),
    2,
    mcpServerName(result.dataDir),
  );

  const written = loadConfig(result.dataDir);
  const embedLines = await embeddingStatusLines(written.embedding);
  const captureLines = appendCaptureRecipe(written.sources, {
    captureAskedAndEmpty: wizard.captureAskedAndEmpty,
    captureSkippedCwd: wizard.captureSkippedCwd,
    dataDir: result.dataDir,
  });

  const lines = [
    ``,
    `${PRODUCT_NAME} initialised.`,
    ``,
    `  Data directory  ${result.dataDir}${result.createdDataDir ? " (created)" : ""}`,
    `  Database        ${
      result.dialect === "postgres"
        ? `Postgres (schema v${result.schemaVersion})`
        : `${result.dbPath} (schema v${result.schemaVersion})`
    }`,
    `  Config          ${result.configPath}${
      result.wroteConfig
        ? " (written)"
        : ` (${INIT_PROMPTS.existingConfig})`
    }`,
    ``,
    `Add to your AI tool's MCP configuration:`,
    ``,
    snippet,
    ``,
    INIT_PROMPTS.mcpVsCli,
    ``,
    `One data directory is one memory.`,
    ``,
    ...providerStatusLines(
      resolveProviderType(written.intelligence.provider),
    ),
    ``,
    ...embedLines,
    ``,
  ];
  console.log(lines.join("\n"));

  // The copy offer runs before the outro, so the next-command line is not
  // printed above the prompt that performs it.
  if (rl) {
    try {
      if (
        shouldOfferInitBackfill({
          ttyWalk: true,
          wroteConfig: result.wroteConfig,
          sources: written.sources,
        })
      ) {
        const provider = resolveProviderType(written.intelligence.provider);
        await offerInitBackfill(bindInitIo(rl), result.dataDir, {
          providerIsHeuristic: provider === "heuristic",
          copy: async (dir) => {
            const cfg = loadConfig(dir);
            return withDb(dir, (db) => copySources(db, cfg.sources));
          },
          unextracted: (dir) => withDb(dir, (db) => unexaminedEventCount(db)),
          // The offer already copied; extract (capped) and integrate. The
          // offer prints the counts itself, on the same channel as its prompts.
          consolidate: async (dir, opts) => {
            const r = await consolidateStore(
              dir,
              { copy: false, extract: true, integrate: true },
              {
                print: false,
                extractLimit: opts.extractLimit,
                extractSince: opts.extractSince,
              },
            );
            return r
              ? { factsIntegrated: r.factsIntegrated, eventsRemaining: r.eventsRemaining }
              : undefined;
          },
        });
      }
    } finally {
      rl.removeListener("SIGINT", onSigint);
      rl.close();
    }
  }

  const outro = [...captureLines, ``];
  if (result.wroteConfig) {
    const later =
      `Later: ${CLI_NAME} settings --data ${cliDataArg(result.dataDir)}  ` +
      `(extra knobs; does not reset this file)`;
    outro.push(later, ``);
  }
  console.log(outro.join("\n"));
}

async function runSettingsCmd() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string" },
      json: { type: "boolean", default: false },
      web: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const target =
    positionals[0] ??
    (values.data as string | undefined) ??
    dataDirFromEnvOrDefault();
  const dataDir = resolveUserPath(target);
  const json = Boolean(values.json);
  const web = Boolean(values.web);
  const ask = Boolean(process.stdin.isTTY) && !json && !web;

  try {
    let code: number;
    if (!ask) {
      code = await runSettings({
        dataDir,
        json,
        web,
        stdinIsTTY: Boolean(process.stdin.isTTY),
        probeHttp: (baseUrl) => probeHttpModels(baseUrl),
      });
    } else {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      const onSigint = () => {
        rl.close();
        process.exit(130);
      };
      rl.on("SIGINT", onSigint);
      try {
        code = await runSettings({
          dataDir,
          json,
          web: false,
          stdinIsTTY: true,
          io: bindInitIo(rl),
          probeHttp: (baseUrl) => probeHttpModels(baseUrl),
        });
      } finally {
        rl.removeListener("SIGINT", onSigint);
        rl.close();
      }
    }
    process.exit(code);
  } catch (err: unknown) {
    console.error(`Failed to change settings in ${dataDir}: ${errorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Open the database for a command, run `fn`, close.
 * Exits with a clear message when the data dir was never initialised, rather
 * than surfacing a raw SQLite error. Postgres stores have no memory.db;
 * the URL is the database, checked by loadShippedStoreConfig / openStore.
 */
async function withDb<T>(
  dataDir: string,
  fn: (db: Db) => T | Promise<T>,
): Promise<T> {
  const config = loadShippedStoreConfig(dataDir);
  if (
    configuredStorageProvider(config) === "sqlite" &&
    !existsSync(sqliteMemoryPath(dataDir))
  ) {
    console.error(
      `No database at ${dataDir}. Run 'facthouse init ${dataDir}' first, ` +
        `or point at another directory with --data.`,
    );
    process.exit(1);
  }
  const db = await openStore(dataDir, config);
  try {
    await applySchema(db);
    return await fn(db);
  } finally {
    await closeDatabase(db);
  }
}

/**
 * Async twin of `withDb`, for commands whose callback is already a Promise.
 */
async function withDbAsync<T>(
  dataDir: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return withDb(dataDir, fn);
}

async function runSearchCmd() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: dataDirFromEnvOrDefault() },
      domain: { type: "string" },
      limit: { type: "string" },
      "as-of-system": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const query = positionals.join(" ").trim();
  if (!query) {
    console.error(
      `Usage: facthouse search <query> [--domain <d>] [--limit <n>] [--as-of-system <t>] [--json]`,
    );
    process.exit(1);
  }

  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    console.error(`Invalid --limit: ${values.limit}. Expected a positive number.`);
    process.exit(1);
  }

  const dataDir = resolveUserPath(values.data as string);
  const config = ensureBitemporalSince(dataDir, loadConfig(dataDir));
  const rawAsOf = values["as-of-system"] as string | undefined;
  if (rawAsOf && config.temporal.mode !== "bitemporal") {
    console.error(
      `as-of system time needs temporal.mode "bitemporal" in config.json. ` +
        `The default simple mode does not record when the system retracted a belief.`,
    );
    process.exit(1);
  }
  let asOfSystemTime: string | undefined;
  if (rawAsOf) {
    try {
      asOfSystemTime = parseSystemTime(rawAsOf);
    } catch (err: unknown) {
      console.error(errorMessage(err));
      process.exit(1);
    }
  }
  // Semantic recall if this store configured it. Reported when configured but
  // unusable, rather than silently searching keyword-only — from the command
  // line there is a person to tell.
  const embedding = createEmbeddingProvider(config.embedding, {
    onUnavailable: (reason) => console.error(`[facthouse] ${reason}`),
  });
  const response = await withDbAsync(dataDir, (db) =>
    runSearch(
      db,
      {
        query,
        domain: values.domain as string | undefined,
        limit,
        asOfSystemTime,
      },
      embedding,
      {
        minSimilarityRatio: config.embedding?.min_similarity_ratio,
        minSimilarity: config.embedding?.min_similarity ?? undefined,
        ann: config.embedding?.ann,
        annMaxBytes: config.embedding?.ann_max_bytes,
      },
      config.interlocutor,
    ),
  );
  if (asOfSystemTime) {
    response.system_time_warning = systemTimeWarning(
      asOfSystemTime,
      config.temporal.bitemporal_since,
    );
  }

  console.log(
    values.json ? JSON.stringify(response, null, 2) : formatSearch(response, query),
  );
}

async function runStatsCmd() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: dataDirFromEnvOrDefault() },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const dataDir = resolveUserPath(values.data as string);
  const stats = await withDb(dataDir, (db) => getStats(db));
  stats.listener = await isServerListening(dataDir);
  const payload = { ...stats, package_version: packageVersion() };

  console.log(values.json ? JSON.stringify(payload, null, 2) : formatStats(stats));
}

async function runInspectCmd() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: dataDirFromEnvOrDefault() },
      layer: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      graph: { type: "boolean", default: false },
      entity: { type: "string" },
      output: { type: "string" },
      all: { type: "boolean", default: false },
    },
    strict: true,
  });
  const dataDir = resolveUserPath(values.data as string);
  const limitRaw = values.limit ? Number(values.limit) : undefined;
  if (limitRaw !== undefined && (!Number.isFinite(limitRaw) || limitRaw < 1)) {
    console.error("inspect --limit must be a positive number.");
    process.exit(1);
  }
  try {
    await withDb(dataDir, async (db) => {
      const result = await runInspect(db, {
        dataDir,
        layer: values.layer as string | undefined,
        limit: limitRaw,
        json: Boolean(values.json),
        graph: Boolean(values.graph),
        entity: values.entity as string | undefined,
        output: values.output as string | undefined,
        all: Boolean(values.all),
        packageVersion: packageVersion(),
      });
      if (result.stdout) console.log(result.stdout);
      if (result.path) console.log(result.path);
    });
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(1);
  }
}

/**
 * Reclaim raw events that nothing can reach.
 *
 * Reports by default and deletes only when asked. Pruning is irreversible and
 * this is a memory product: the difference between "here is what would go" and
 * "it has gone" must be a deliberate keystroke, not a default.
 */
async function runPruneCmd() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: dataDirFromEnvOrDefault() },
      apply: { type: "boolean", default: false },
      vacuum: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const dataDir = resolveUserPath(values.data as string);
  const config = loadConfig(dataDir);
  // Defers to the setting it protects rather than repeating its default, unless
  // a store has deliberately overridden it.
  const keep =
    config.retention?.prune_keep_per_session ??
    config.extraction?.working_memory_size ??
    DEFAULT_CONFIG.extraction.working_memory_size;
  const apply = values.apply as boolean;

  const result = await withDb(dataDir, async (db) => {
    const stats = apply ? await pruneEvents(db, keep) : await prunableEvents(db, keep);
    // Only after a successful delete — vacuuming a database nothing was removed
    // from is a long rewrite for no reason.
    if (apply && (values.vacuum as boolean) && stats.events > 0) {
      await vacuum(db);
      const cap = getBoundDiskBudget(db);
      if (cap && db.dialect === "sqlite") {
        await applySqliteDiskBudget(db, cap.bytes);
      }
    }
    return stats;
  });

  if (values.json) {
    console.log(JSON.stringify({ ...result, applied: apply }, null, 2));
    return;
  }
  console.log(formatPrune(result, apply, keep, values.vacuum as boolean));
}

// ---------------------------------------------------------------------------
// consolidate — the one verb that spends model calls
// ---------------------------------------------------------------------------

async function runConsolidate() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      data: { type: "string", default: dataDirFromEnvOrDefault() },
      copy: { type: "boolean", default: false, short: "c" },
      extract: { type: "boolean", default: false, short: "e" },
      integrate: { type: "boolean", default: false, short: "i" },
      all: { type: "boolean", default: false, short: "a" },
      limit: { type: "string", short: "l" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const dataDir = resolveUserPath(values.data as string);

  // undefined → the default cap; null → no cap; a number → that many.
  let extractLimit: number | null | undefined = undefined;
  if (values.all) extractLimit = null;
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 1) {
      console.error("--limit must be a whole number of at least 1");
      process.exit(1);
    }
    extractLimit = n;
  }

  await consolidateStore(dataDir, stepsFromFlags(values), {
    extractLimit,
    json: Boolean(values.json),
  });
}

interface ConsolidateStoreOpts {
  /** undefined: default cap; null: no cap; number: that many oldest lines. */
  extractLimit?: number | null;
  /** Init historic window. See ConsolidateCaller.extractSince. */
  extractSince?: Date;
  /** Print the result object instead of the human summary. */
  json?: boolean;
  /** Print nothing on success (the init offer prints its own lines). */
  print?: boolean;
}

/**
 * Consolidate a store in this process with its configured provider. This is
 * the manual path: no MCP server is involved. A `sampling` selection has no
 * server to sample from and degrades to heuristic; `cli` spawns `claude -p`
 * directly. The FACTHOUSE_SUBPROCESS guard at the top of main() prevents
 * recursion when this runs inside a provider subprocess.
 */
async function consolidateStore(
  dataDir: string,
  steps: ConsolidateSteps,
  opts: ConsolidateStoreOpts = {},
): Promise<ConsolidationResult | undefined> {
  const config = ensureBitemporalSince(dataDir, loadConfig(dataDir));
  if (!steps.extract && !steps.integrate) {
    // Copy only: no model, no embeddings, no vocabulary. The heuristic
    // provider is a placeholder consolidate() never calls on this path.
    return consolidateInProcess(
      dataDir,
      createHeuristicProvider(),
      config,
      null,
      steps,
      opts,
    );
  }
  if (
    steps.extract &&
    resolveProviderType(config.intelligence.provider) === "heuristic"
  ) {
    console.error(
      "[facthouse] intelligence.provider is heuristic — it does not extract " +
        "facts from transcripts. capture_fact still works.",
    );
  }
  const vocabulary = await withDb(dataDir, (db) =>
    loadStoreVocabulary(db, config.domains ?? []),
  );
  const provider = createIntelligenceProvider(config.intelligence, {
    vocabulary,
  });
  // Embeddings are written here too, not only by the server. `facthouse
  // consolidate` is the documented way to process a store by hand, and a store
  // consolidated that way would otherwise never gain a vector.
  const embedding = createEmbeddingProvider(config.embedding, {
    onUnavailable: (reason) => console.error(`[facthouse] ${reason}`),
  });
  return consolidateInProcess(dataDir, provider, config, embedding, steps, opts);
}

/**
 * Open the DB at dataDir, run consolidate() with the given provider and steps,
 * report, then close. The copy step reads `config.sources` through the same
 * copySources the server's heartbeat uses — one copy path.
 */
export async function consolidateInProcess(
  dataDir: string,
  provider: IntelligenceProvider,
  config: Partial<ServerConfig> = DEFAULT_CONFIG,
  embedding: EmbeddingProvider | null = null,
  steps: ConsolidateSteps = ALL_STEPS,
  opts: ConsolidateStoreOpts = {},
): Promise<ConsolidationResult | undefined> {
  const storeConfig = loadShippedStoreConfig(dataDir);
  const db = await openStore(dataDir, storeConfig);

  try {
    await applySchema(db);
    const result = await consolidate(db, provider, config, embedding, steps, {
      trigger: "cli",
      project: envValue("PROJECT") ?? null,
      copy: () => copySources(db, config.sources),
      extractLimit: opts.extractLimit,
      extractSince: opts.extractSince,
    });
    if (result.skipped && result.skipReason) {
      console.error(`[facthouse] ${result.skipReason}`);
    }
    if (result.extractionDegraded) {
      if (result.prefixCommitted) {
        console.error(
          `[facthouse] Extraction stopped after a failed call. Facts from earlier examined events were kept and the watermark advanced to ${result.examinedThrough}. Remaining events are still eligible. Re-run ${CLI_NAME} consolidate to continue.`,
        );
      } else {
        console.error(
          `[facthouse] Extraction could not run — events were not examined and the watermark was held. A zero factsIntegrated here is not a successful empty extract. Re-run ${CLI_NAME} consolidate when the CLI provider can run.`,
        );
      }
    }
    if (
      opts.print !== false &&
      steps.extract &&
      !result.extractionDegraded &&
      result.eventsRemaining > 0
    ) {
      console.error(
        `[facthouse] ${result.eventsRemaining} line(s) still waiting to be extracted. ` +
          `Run ${CLI_NAME} consolidate --all to take them all now, or --limit N for the oldest N.`,
      );
    }
    if (opts.print !== false) {
      console.log(opts.json ? JSON.stringify(result) : formatConsolidate(result));
    }
    return result;
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(1);
  } finally {
    await closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// notify — tell the running server a moment happened
// ---------------------------------------------------------------------------

/**
 * The server decides what to run for a moment (the policy lives with the
 * engine); this process only relays and exits, so a hook returns at once.
 * No server listening is not an error: the next session start covers it.
 */
async function runNotify() {
  const momentArg = process.argv[3];
  const { values } = parseArgs({
    args: process.argv.slice(4),
    options: {
      data: { type: "string", default: dataDirFromEnvOrDefault() },
    },
    strict: true,
  });
  if (!momentArg || !isNotifiableMoment(momentArg)) {
    console.error(
      `Usage: ${CLI_NAME} notify <moment> [--data <dir>]\n` +
        `Moments: ${NOTIFIABLE_MOMENTS.join(", ")}`,
    );
    process.exit(1);
  }
  const dataDir = resolveUserPath(values.data as string);
  await notifyMoment(dataDir, momentArg);
}

async function notifyMoment(
  dataDir: string,
  moment: NotifiableMoment,
): Promise<void> {
  const delivered = await notifyServer(dataDir, moment);
  if (!delivered) {
    console.error(
      `[facthouse] No MCP server is listening for this store, so there is nothing ` +
        `to notify. Run ${CLI_NAME} consolidate to process pending events now.`,
    );
  }
  console.log(JSON.stringify({ delivered, moment }));
}

async function runRecord() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      role: { type: "string", default: "user" },
      "event-type": { type: "string", default: "message" },
      "content-type": { type: "string", default: "text" },
      content: { type: "string" },
      "session-id": { type: "string" },
      speaker: { type: "string" },
      data: { type: "string", default: dataDirFromEnvOrDefault() },
    },
    strict: true,
  });

  const role = values.role as string;
  const eventType = values["event-type"] as string;
  const contentType = values["content-type"] as string;

  if (!isSessionRole(role)) {
    console.error(`Invalid --role: ${role}. Must be one of: ${SESSION_ROLES.join(", ")}`);
    process.exit(1);
  }

  if (!isSessionEventType(eventType)) {
    console.error(
      `Invalid --event-type: ${eventType}. Must be one of: ${SESSION_EVENT_TYPES.join(", ")}`,
    );
    process.exit(1);
  }

  if (!isSessionContentType(contentType)) {
    console.error(
      `Invalid --content-type: ${contentType}. Must be one of: ${SESSION_CONTENT_TYPES.join(", ")}`,
    );
    process.exit(1);
  }

  // Content from --content flag or stdin (for hooks).
  let content = values.content as string | undefined;
  let sessionId = values["session-id"] as string | undefined;

  if (!content) {
    const stdin = await readStdin();
    if (stdin.trim()) {
      const extracted = extractContentFromHookPayload(stdin.trim());
      content = extracted.content;
      sessionId = sessionId ?? extracted.sessionId;
    }
  }

  if (!content) {
    console.error("No content provided. Use --content or pipe via stdin.");
    process.exit(1);
  }

  try {
    const event = await recordEvent({
      role,
      eventType,
      content,
      contentType,
      sessionId,
      speaker: (values.speaker as string | undefined) ?? null,
      dataDir: resolveUserPath(values.data as string),
    });

    console.log(JSON.stringify({ event_id: event.id, sequence: event.sequence }));
  } catch (err: unknown) {
    console.error(errorMessage(err));
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exit(1);
});
