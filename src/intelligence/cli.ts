/**
 * CLI-subprocess intelligence provider.
 *
 * Spawns `claude -p --output-format json --json-schema ...` for each semantic
 * stage of consolidation. Uses the user's existing Claude subscription via
 * OAuth, so no API key is needed — the subprocess inherits the parent's
 * environment and claude's keychain/file-based credentials resolve naturally.
 *
 * Four stages per consolidation (~4 subprocess calls total):
 *   1. Extract-classify-resolve — facts + entities + domain + signals
 *   2. Reconcile — add / noop / enrich against existing domain facts
 *   3. Supersede — detect semantic contradictions against existing active facts
 *   4. Summarise — narrative paragraph + open threads
 *
 * extractEntities and classifyFacts are 0-cost — they reuse stage 1 output
 * stored on session_facts (consolidate() orchestrates this). Heuristic
 * fallback only when the whole subprocess mechanism fails (CLI missing,
 * spawn error, consistent schema validation failure).
 *
 * Recursion prevention (three layers):
 *   1. --setting-sources user     → skip project-level hook settings
 *   2. cwd outside project        → don't auto-discover project settings
 *   3. OPENMEMORY_SUBPROCESS=1 env → our own hook CLI early-exits if set
 *
 * Probes verified the first two layers independently prevent recursion
 * (baseline logged 2 events, each guard alone logged 0). The env var is
 * belt-and-braces insurance for edge cases.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IntelligenceProvider, ExtractedFact, ExtractedEntity, Referent } from "./types.js";
import { createHeuristicProvider } from "./heuristic.js";
import { domainRoutingInstruction, normaliseDomainName } from "../schemas/domains.js";
import type { DomainDef } from "../types/config.js";
import {
  EXTRACT_CONTEXT_CONTRACT,
  SUBJECT_MARKING_CONTRACT,
  extractEventPayload,
  extractTodayUtcDate,
  parseExtractedIso,
} from "./extract-prompt.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CliProviderOpts {
  /** Command + args to invoke the CLI. Default: `['claude']` (resolved via PATH). */
  command?: string[];
  /** Model alias (passed via --model). Default: `haiku`. */
  model?: string;
  /** Per-stage timeout in ms. Default: 20_000 (20s). */
  timeoutMs?: number;
  /** Cwd for subprocess. Default: OS tempdir (out of project scope). */
  cwd?: string;
  /** Max existing entities per type to pass to stage 1 as resolution candidates. */
  maxCandidates?: number;
  /** Enable debug logging to stderr. */
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Tracked children for cleanup on parent death
// ---------------------------------------------------------------------------

const activeChildren = new Set<import("node:child_process").ChildProcess>();

function trackChild(child: import("node:child_process").ChildProcess): void {
  activeChildren.add(child);
  child.once("exit", () => activeChildren.delete(child));
}

// Register once at module load to reap children on process exit.
// Avoids orphaned claude subprocesses if the MCP server crashes.
if (typeof process !== "undefined") {
  const reap = () => {
    for (const child of activeChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };
  process.once("exit", reap);
  process.once("SIGINT", reap);
  process.once("SIGTERM", reap);
}

// ---------------------------------------------------------------------------
// Subprocess invocation
// ---------------------------------------------------------------------------

interface SubprocessResult {
  /** Full parsed envelope from --output-format json. */
  envelope: Record<string, unknown>;
  /** The schema-validated structured output, or null if unavailable. */
  structured: unknown;
  elapsedMs: number;
}

interface SubprocessFailure {
  error: "timeout" | "spawn-error" | "non-zero-exit" | "parse-error" | "no-structured-output" | "is-error";
  detail?: string;
  exitCode?: number | null;
  stderr?: string;
}

async function invokeClaude(
  prompt: string,
  schema: unknown,
  command: string[],
  opts: Required<CliProviderOpts>,
): Promise<SubprocessResult | SubprocessFailure> {
  const cmd = command[0];
  // Prompt goes on stdin, not argv. Windows CreateProcess caps the command
  // line at 32,767 characters; a stage-1 extract (schema + events + evidence)
  // exceeds that routinely, spawn fails with ENAMETOOLONG, and extract
  // degrades for every run. `claude -p` with no positional prompt reads stdin
  // (`echo "…" | claude -p`). The JSON schema stays on argv — it is small.
  const args = [
    ...command.slice(1),
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--setting-sources",
    "user",
    "--no-session-persistence",
    "--model",
    opts.model,
  ];

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value: SubprocessResult | SubprocessFailure) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    let child: import("node:child_process").ChildProcess;
    const started = Date.now();
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: false,
        env: { ...process.env, OPENMEMORY_SUBPROCESS: "1" },
      });
    } catch (err) {
      return finish({ error: "spawn-error", detail: (err as Error).message });
    }
    trackChild(child);

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 2000);
      finish({ error: "timeout" });
    }, opts.timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.stdin?.on("error", () => {
      // EPIPE if the child exits before consuming the prompt; close/error
      // handlers below settle the result.
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ error: "spawn-error", detail: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return finish({
          error: "non-zero-exit",
          exitCode: code,
          stderr: stderr.slice(0, 300),
        });
      }
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(stdout);
      } catch (err) {
        return finish({ error: "parse-error", detail: (err as Error).message });
      }
      if (envelope.is_error === true) {
        return finish({
          error: "is-error",
          detail: String(envelope.result ?? ""),
        });
      }
      const structured = envelope.structured_output;
      if (structured === undefined || structured === null) {
        return finish({
          error: "no-structured-output",
          detail: String(envelope.result ?? "").slice(0, 300),
        });
      }
      finish({
        envelope,
        structured,
        elapsedMs: Date.now() - started,
      });
    });

    try {
      child.stdin?.end(prompt, "utf8");
    } catch {
      // Child already closed stdin; close/error handlers settle the result.
    }
  });
}

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the claude CLI invocation. Returns a spawn-friendly argv prefix.
 *
 * Strategy (first match wins):
 *   1. Explicit opts.command
 *   2. CLAUDE_CLI_PATH env var — either a direct binary or a .cjs path
 *   3. Global npm install's cli-wrapper.cjs invoked via `node` — works
 *      universally including Windows where `.cmd` shims can't be spawned
 *      directly due to Node's CVE-2024-27980 mitigation
 *   4. Plain `claude` in PATH — works on Unix systems with functioning shims
 *
 * Result is cached; caller invokes resolve() once at provider construction.
 */
function resolveCommand(opts: CliProviderOpts): string[] {
  if (opts.command && opts.command.length > 0) return opts.command;
  if (process.env.CLAUDE_CLI_PATH) {
    const p = process.env.CLAUDE_CLI_PATH;
    return p.endsWith(".cjs") || p.endsWith(".js")
      ? [process.execPath, p]
      : [p];
  }

  // Probe for cli-wrapper.cjs via `npm root -g`. Works on every platform
  // because we spawn node directly — no .cmd/.exe/.sh shim resolution needed.
  const wrapperFromNpmRoot = findWrapperViaNpmRoot();
  if (wrapperFromNpmRoot) return [process.execPath, wrapperFromNpmRoot];

  // Fallback: resolve `claude` via where/which and derive wrapper path from
  // the npm bin directory (its parent contains node_modules/@anthropic-ai/).
  const wrapperFromShim = findWrapperViaShimPath();
  if (wrapperFromShim) return [process.execPath, wrapperFromShim];

  // Last resort — plain `claude` command. Works on Unix systems with a
  // functioning symlink shim; on Windows Node ≥22 with a .cmd shim this will
  // EINVAL and we'll fall through to heuristic.
  return ["claude"];
}

function findWrapperViaNpmRoot(): string | null {
  try {
    // One command string rather than (command, args) — with `shell: true` an
    // args array triggers Node's DEP0190 deprecation warning, which lands in
    // the user's terminal during `openmemory init`. The shell is needed on
    // Windows, where `npm` is a `.cmd` shim that cannot be spawned directly.
    const r = spawnSync("npm root -g", {
      encoding: "utf-8",
      shell: true,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const candidate = path.join(
      r.stdout.trim(),
      "@anthropic-ai",
      "claude-code",
      "cli-wrapper.cjs",
    );
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function findWrapperViaShimPath(): string | null {
  try {
    const r = spawnSync(
      process.platform === "win32" ? "where" : "which",
      ["claude"],
      { encoding: "utf-8" },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const shimPath = r.stdout.split("\n")[0].trim();
    if (!shimPath) return null;
    const binDir = path.dirname(shimPath);
    const candidate = path.join(
      binDir,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli-wrapper.cjs",
    );
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Availability probe
// ---------------------------------------------------------------------------

/** How the runner reports back. Only the exit status matters. */
export interface ProbeRun {
  status: number | null;
}

export interface CliProbeResult {
  /** The argv prefix the provider would spawn. */
  command: string[];
  /** The command answered `--version`, so the provider will really work. */
  available: boolean;
}

/**
 * Ask whether the CLI provider can actually run, rather than whether a path
 * could be constructed for it.
 *
 * `resolveCommand` always returns *something* — its last resort is a bare
 * `claude`, on the chance a working shim is on PATH. So a resolved command is
 * not evidence of an installed CLI, and the difference is invisible until
 * consolidation silently degrades: every stage falls back to the heuristic
 * provider, which extracts no entities and does no routing. The store fills
 * with flat facts and nothing says why.
 *
 * Spawning `--version` is the only answer that settles it. It costs one fast
 * subprocess, needs no model call, and catches the case a file-existence check
 * cannot — a Windows `.cmd` shim that is present but cannot be spawned
 * directly (Node's CVE-2024-27980 mitigation), which is exactly how this fails
 * on the platform most likely to hit it.
 *
 * @param opts provider options, as passed to `createCliProvider`
 * @param run  injection seam for tests; defaults to a real subprocess
 */
export function probeCliProvider(
  opts: CliProviderOpts = {},
  run: (cmd: string, args: string[]) => ProbeRun = defaultProbeRun,
): CliProbeResult {
  const command = resolveCommand(opts);
  const result = run(command[0], [...command.slice(1), "--version"]);
  return { command, available: result.status === 0 };
}

function defaultProbeRun(cmd: string, args: string[]): ProbeRun {
  try {
    const r = spawnSync(cmd, args, {
      encoding: "utf-8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, OPENMEMORY_SUBPROCESS: "1" },
    });
    return { status: r.status };
  } catch {
    // A spawn that throws (ENOENT, EINVAL) is the same answer as a non-zero
    // exit: this command cannot be run.
    return { status: null };
  }
}

// ---------------------------------------------------------------------------
// Stage schemas (JSON Schema draft-07)
// ---------------------------------------------------------------------------

const STAGE_1_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          domain: { type: "string" },
          subdomain: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          importance: { type: "number", minimum: 0, maximum: 1 },
          capture_context: { type: ["string", "null"] },
          valid_from: { type: ["string", "null"] },
          valid_until: { type: ["string", "null"] },
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                relationship: {
                  type: "string",
                  description:
                    "How this fact relates to this thing. Use exactly " +
                    "'subject_of' for the ONE thing the fact is about; describe " +
                    "the connection in your own words for everything else it " +
                    "merely mentions.",
                },
                existing_id: { type: ["string", "null"] },
              },
              required: ["name", "type", "relationship"],
            },
          },
        },
        required: ["content", "domain", "entities"],
      },
    },
    session_now: { type: ["string", "null"] },
    referents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phrase: { type: "string" },
          binding: { type: "string" },
        },
        required: ["phrase", "binding"],
      },
    },
    topic_shifted: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["facts"],
};

const STAGE_CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          domain: { type: "string" },
          subdomain: { type: ["string", "null"] },
        },
        required: ["id", "domain"],
      },
    },
  },
  required: ["classifications"],
};

const STAGE_ENTITIES_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                relationship: {
                  type: "string",
                  description:
                    "How this fact relates to this thing. Use exactly " +
                    "'subject_of' for the ONE thing the fact is about; describe " +
                    "the connection in your own words for everything else it " +
                    "merely mentions.",
                },
              },
              required: ["name", "type", "relationship"],
            },
          },
        },
        required: ["id", "entities"],
      },
    },
  },
  required: ["facts"],
};

const STAGE_2_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          decision: { type: "string", enum: ["add", "noop", "enrich"] },
          existingFactId: { type: ["string", "null"] },
        },
        required: ["id", "decision"],
      },
    },
  },
  required: ["decisions"],
};

const STAGE_3_SCHEMA = {
  type: "object",
  properties: {
    supersessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          new_id: { type: "string" },
          existing_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["new_id", "existing_id", "reason"],
      },
    },
  },
  required: ["supersessions"],
};

const STAGE_4_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    openThreads: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "openThreads"],
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createCliProvider(
  userOpts: CliProviderOpts = {},
  fallback: IntelligenceProvider = createHeuristicProvider(),
  /**
   * The store's configured vocabulary, named in the routing prompt so the model
   * reuses "medical" rather than coining "health". Empty means the model is
   * choosing this store's vocabulary from scratch, which is a legitimate state:
   * the engine ships none.
   */
  vocabulary: DomainDef[] = [],
): IntelligenceProvider {
  const opts: Required<CliProviderOpts> = {
    // Resolved lazily below — kept here only to satisfy the Required shape.
    command: [],
    model: userOpts.model ?? "haiku",
    // 45s covers the heavier stage 1 (nested schema + entity resolution).
    // Measured: simple prompts 8–15s; stage 1 with full schema 20–35s
    // observed. Budget is per stage, not total — 4 stages × 45s = up to 3
    // minutes worst case, which is still a background job.
    timeoutMs: userOpts.timeoutMs ?? 45_000,
    cwd: userOpts.cwd ?? tmpdir(),
    maxCandidates: userOpts.maxCandidates ?? 50,
    debug: userOpts.debug ?? false,
  };

  // Resolve the claude invocation lazily and cache it. Deferring resolution
  // until the first stage call keeps provider construction cheap and
  // side-effect-free: an idle server that never consolidates never shells out
  // to `npm root -g` for wrapper discovery (which on Windows also emits a
  // shell-spawn deprecation warning). Matters because `cli` is the default
  // provider — every boot constructs it, but most boots never invoke it.
  let resolvedCommand: string[] | null =
    userOpts.command && userOpts.command.length > 0 ? userOpts.command : null;
  const getCommand = (): string[] => {
    if (!resolvedCommand) resolvedCommand = resolveCommand(userOpts);
    return resolvedCommand;
  };

  const log = (...args: unknown[]) => {
    if (opts.debug) console.error("[openmemory cli-provider]", ...args);
  };

  /** Standardised stage runner. Returns null on failure so callers can fall back. */
  async function runStage<T>(
    stageName: string,
    systemPrompt: string,
    userPayload: unknown,
    schema: unknown,
  ): Promise<T | null> {
    // Claude's --json-schema flag expects a user prompt; we pass the system
    // prompt prepended to the user content, separated by a marker. We don't
    // use --system-prompt because the help docs note it interacts with
    // --exclude-dynamic-system-prompt-sections and other flags; this keeps
    // behaviour predictable.
    const prompt = `${systemPrompt}\n\nINPUT:\n${JSON.stringify(userPayload)}`;
    const result = await invokeClaude(prompt, schema, getCommand(), opts);
    if ("error" in result) {
      log(`${stageName} failed (${result.error}):`, result.detail ?? "");
      return null;
    }
    log(`${stageName} ok in ${result.elapsedMs}ms`);
    return result.structured as T;
  }

  return {
    async extractFactsFromEvents(events, workingMemory, sessionSummary, longTermMemory, extras) {
      // Nothing to examine is not a failure — there is no watermark to hold back.
      if (events.length === 0) return { facts: [], degraded: false };
      const result = await runStage<{
        facts: Array<{
          content: string;
          domain: string;
          subdomain?: string | null;
          confidence?: number;
          importance?: number;
          capture_context?: string | null;
          valid_from?: string | null;
          valid_until?: string | null;
          entities: Array<{
            name: string;
            type: string;
            relationship: string;
            existing_id?: string | null;
          }>;
        }>;
        session_now?: string | null;
        referents?: Referent[];
        topic_shifted?: boolean;
        confidence?: number;
      }>(
        "stage-1-extract",
        "You extract durable facts from conversation events — facts worth " +
          "remembering across future sessions. A durable fact is a stable piece " +
          "of knowledge about whatever this store is used for: its subjects, " +
          "their attributes, their relationships, decisions, and context. " +
          "Ignore ephemeral statements (current tasks, transient mood). " +
          "Each fact must be a complete, self-contained sentence — rewrite from the source as needed. " +
          `${domainRoutingInstruction(vocabulary)} ` +
          "optional subdomain, confidence 0-1, importance 0-1, and any named " +
          "things mentioned (people, organisations, places, projects, products, " +
          "systems, concepts — whatever the fact concerns), each with a short lowercase type. " +
          SUBJECT_MARKING_CONTRACT + " " +
          EXTRACT_CONTEXT_CONTRACT + " " +
          "If an entity matches one of the entities referenced in long_term_memory (by name or " +
          "clear reference), set existing_id to the matching id; otherwise omit existing_id " +
          "(= new entity). " +
          "Return strictly {facts: [...], session_now?, referents?, topic_shifted?, confidence?}.",
        {
          session_now: extras?.now ?? null,
          referents: extras?.referents ?? [],
          topic_segments: extras?.segments ?? [],
          session_summary: sessionSummary ?? null,
          long_term_memory: (longTermMemory ?? []).map((f) => ({
            id: f.id,
            content: f.content,
            domain: f.domain,
          })),
          extract_today: extractTodayUtcDate(),
          recent_events: workingMemory.map(extractEventPayload),
          reminder_events: (extras?.reminderEvents ?? []).map(extractEventPayload),
          candidate_events: events.map(extractEventPayload),
        },
        STAGE_1_SCHEMA,
      );

      if (!result || !Array.isArray(result.facts)) {
        // The subprocess failed, timed out, or returned something unusable.
        // Falling back keeps consolidation moving, but the caller must know the
        // configured extractor never ran: these events have NOT been examined,
        // and advancing past them would discard them permanently.
        const fell = await fallback.extractFactsFromEvents(
          events,
          workingMemory,
          sessionSummary,
          longTermMemory,
          extras,
        );
        return { facts: fell.facts, degraded: true };
      }

      const extracted: ExtractedFact[] = result.facts.map((f) => ({
        content: f.content,
        domain_hint: f.domain,
        subdomain_hint: f.subdomain ?? null,
        confidence_signal: typeof f.confidence === "number" ? f.confidence : null,
        importance_signal: typeof f.importance === "number" ? f.importance : null,
        capture_context: f.capture_context ?? null,
        valid_from: parseExtractedIso(f.valid_from),
        valid_until: parseExtractedIso(f.valid_until),
        entities: Array.isArray(f.entities)
          ? f.entities.map((e) => ({
              name: e.name,
              type: e.type,
              relationship: e.relationship,
              existing_id: e.existing_id ?? undefined,
            }))
          : [],
        source_quality: "cli",
      }));
      return {
        facts: extracted,
        degraded: false,
        now: result.session_now,
        referents: Array.isArray(result.referents) ? result.referents : undefined,
        topic_shifted: result.topic_shifted,
        confidence: typeof result.confidence === "number" ? result.confidence : undefined,
      };
    },

    async classifyFacts(facts, sessionContext) {
      // Facts inferred from events are routed during stage 1 and arrive with a
      // domain_hint, so consolidation never asks about them. What reaches here
      // is the explicit capture path — capture_fact — which is the path every
      // tool description tells an assistant to use.
      //
      // This used to delegate straight to the heuristic. That was defensible
      // while the heuristic carried a keyword vocabulary; once the engine
      // stopped shipping one, the delegation quietly meant "route everything to
      // the fallback domain". Measured on the same sentence: arriving as an
      // event it was routed to a real domain; arriving through capture_fact it
      // landed in the default one.
      if (facts.length === 0) return [];

      const result = await runStage<{
        classifications: Array<{
          id: string;
          domain: string;
          subdomain?: string | null;
        }>;
      }>(
        "stage-classify",
        "You route already-extracted facts into domains. " +
          `${domainRoutingInstruction(vocabulary)} ` +
          "Also give an optional short lowercase subdomain where one is " +
          "genuinely useful, or null. " +
          "Return a classification for EVERY fact you are given, keyed by its " +
          "id. Return strictly {classifications: [{id, domain, subdomain}]}.",
        {
          session_context: sessionContext ?? null,
          facts: facts.map((f) => ({
            id: f.id,
            content: f.content,
            domain_hint: f.domain_hint ?? null,
          })),
        },
        STAGE_CLASSIFY_SCHEMA,
      );

      if (!result || !Array.isArray(result.classifications)) {
        return fallback.classifyFacts(facts, sessionContext);
      }

      // Index the model's answers and reconcile against the input. A fact the
      // model skipped still has to come back classified, or consolidation would
      // silently drop it — so anything missing falls through to the heuristic
      // rather than being invented here.
      const byId = new Map(result.classifications.map((c) => [c.id, c]));
      const missing = facts.filter((f) => !byId.has(f.id));
      const heuristicForMissing = missing.length
        ? await fallback.classifyFacts(missing, sessionContext)
        : [];
      const heuristicById = new Map(heuristicForMissing.map((c) => [c.id, c]));

      return facts.map((f) => {
        const c = byId.get(f.id);
        if (!c) return heuristicById.get(f.id)!;
        return {
          id: f.id,
          content: f.content,
          domain: normaliseDomainName(c.domain),
          subdomain: c.subdomain ?? null,
        };
      });
    },

    async extractEntities(facts) {
      // Same story as classifyFacts. Facts inferred from events carry entities
      // extracted during stage 1; what arrives here came through capture_fact,
      // and the heuristic this used to delegate to extracts nothing at all by
      // design. So the primary capture path built no graph whatsoever.
      if (facts.length === 0) return new Map();

      const result = await runStage<{
        facts: Array<{
          id: string;
          entities: Array<{ name: string; type: string; relationship: string }>;
        }>;
      }>(
        "stage-entities",
        "You identify the named things each fact concerns — people, " +
          "organisations, places, projects, products, systems, concepts — " +
          "whatever the fact is about, each with a short lowercase type. " +
          SUBJECT_MARKING_CONTRACT + " " +
          "Return an entry for every fact, with an empty list where a fact " +
          "names nothing. Return strictly {facts: [{id, entities}]}.",
        { facts: facts.map((f) => ({ id: f.id, content: f.content })) },
        STAGE_ENTITIES_SCHEMA,
      );

      if (!result || !Array.isArray(result.facts)) {
        return fallback.extractEntities(facts);
      }

      const map = new Map<string, ExtractedEntity[]>();
      for (const f of result.facts) {
        if (!Array.isArray(f.entities) || f.entities.length === 0) continue;
        map.set(
          f.id,
          f.entities.map((e) => ({
            name: e.name,
            type: e.type,
            relationship: e.relationship,
          })),
        );
      }
      return map;
    },

    async reconcile(candidate, existingFacts) {
      if (existingFacts.length === 0) return { kind: "add" };
      const result = await runStage<{
        decisions: Array<{
          id: string;
          decision: "add" | "noop" | "enrich";
          existingFactId?: string | null;
        }>;
      }>(
        "stage-2-reconcile",
        "You decide whether a candidate fact is already covered by an existing fact. " +
          "'noop' = the EXACT same information exists. " +
          "'enrich' = a paraphrase or corroboration of a specific existing fact — " +
          "set existingFactId to that fact's id. " +
          "'add' = the candidate adds something new or stands alone. " +
          "Supersession (contradictions) is handled separately — treat contradictions as 'add'. " +
          "Return strictly {decisions: [{id, decision, existingFactId?}]}.",
        {
          candidates: [{ id: candidate.id, content: candidate.content }],
          existing: existingFacts.map((f) => ({ id: f.id, content: f.content })),
        },
        STAGE_2_SCHEMA,
      );

      if (!result || !Array.isArray(result.decisions) || result.decisions.length === 0) {
        return fallback.reconcile(candidate, existingFacts);
      }
      const decision = result.decisions[0];
      if (decision.decision === "noop") return { kind: "noop" };
      if (decision.decision === "enrich" && typeof decision.existingFactId === "string") {
        const exists = existingFacts.some((f) => f.id === decision.existingFactId);
        return exists
          ? { kind: "enrich", existingFactId: decision.existingFactId }
          : { kind: "add" };
      }
      return { kind: "add" };
    },

    async detectSupersession(newFact, existingFacts) {
      const candidates = existingFacts.filter(
        (f) => f.domain === newFact.domain && f.status === "active" && f.is_latest,
      );
      if (candidates.length === 0) return null;

      const result = await runStage<{
        supersessions: Array<{
          new_id: string;
          existing_id: string;
          reason: string;
        }>;
      }>(
        "stage-3-supersede",
        "You detect whether a new fact supersedes (invalidates and replaces) an existing one. " +
          "Supersession applies for negations, updates, or replacements — e.g. " +
          "'I moved to Porto' supersedes 'I live in Lisbon'; " +
          "'I no longer drink coffee' supersedes 'I prefer coffee'. " +
          "Paraphrase or additional detail is NOT supersession. " +
          "Return strictly {supersessions: [{new_id, existing_id, reason}]} — " +
          "omit entries where no supersession applies.",
        {
          new: [{ id: newFact.id, content: newFact.content, domain: newFact.domain }],
          existing: candidates.map((f) => ({ id: f.id, content: f.content })),
        },
        STAGE_3_SCHEMA,
      );

      if (!result || !Array.isArray(result.supersessions)) {
        return fallback.detectSupersession(newFact, existingFacts);
      }

      // Find the first supersession targeting our newFact.
      const hit = result.supersessions.find((s) => s.new_id === newFact.id);
      if (!hit) return null;
      const exists = candidates.some((f) => f.id === hit.existing_id);
      if (!exists) return null; // hallucinated id
      return { existingFactId: hit.existing_id, reason: hit.reason };
    },

    async summarise(sessionFacts, graduatedFacts, priorSummary, closedTopics) {
      if (graduatedFacts.length === 0) {
        return { summary: "No facts graduated.", openThreads: [] };
      }
      const result = await runStage<{
        summary: string;
        openThreads: string[];
      }>(
        "stage-4-summarise",
        "You summarise a consolidation run. " +
          "prior_summary is the rolling summary of this session so far (may be null for the " +
          "first consolidation). closed_topics are activity gists closed this run (may be empty). " +
          "Produce a CUMULATIVE summary that folds what was just learned " +
          "(graduated) into prior_summary — one natural paragraph, not a diff — " +
          "and mentions closed topics without treating the paragraph as the topic log. " +
          "List up to 5 open threads — questions or follow-ups the user might want revisited. " +
          "Return strictly {summary, openThreads}.",
        {
          prior_summary: priorSummary ?? null,
          closed_topics: closedTopics ?? [],
          graduated: graduatedFacts.map((f) => ({
            content: f.content,
            domain: f.domain,
            subdomain: f.subdomain,
          })),
        },
        STAGE_4_SCHEMA,
      );

      if (
        !result ||
        typeof result.summary !== "string" ||
        !Array.isArray(result.openThreads)
      ) {
        return fallback.summarise(sessionFacts, graduatedFacts, priorSummary);
      }
      return { summary: result.summary, openThreads: result.openThreads };
    },
  };
}
