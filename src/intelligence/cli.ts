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
import type { IntelligenceProvider, ExtractedFact } from "./types.js";
import { createHeuristicProvider } from "./heuristic.js";
import { domainRoutingInstruction } from "../schemas/domains.js";

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
    prompt,
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

    // stdin unused — prompt goes via argv — but close it so the subprocess
    // doesn't wait indefinitely if it tries to read.
    child.stdin?.end();
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
    const r = spawnSync("npm", ["root", "-g"], {
      encoding: "utf-8",
      shell: process.platform === "win32",
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
                relationship: { type: "string" },
                existing_id: { type: ["string", "null"] },
              },
              required: ["name", "type", "relationship"],
            },
          },
        },
        required: ["content", "domain", "entities"],
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
    async extractFactsFromEvents(events, workingMemory, sessionSummary, longTermMemory) {
      if (events.length === 0) return [];
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
      }>(
        "stage-1-extract",
        "You extract durable facts about the user from conversation events. " +
          "A durable fact is something worth remembering for future sessions: preferences, " +
          "personal details, medical info, relationships, work context, opinions, decisions. " +
          "Ignore ephemeral statements (current tasks, transient mood). " +
          "Each fact must be a complete, self-contained sentence — rewrite from the source as needed. " +
          `${domainRoutingInstruction()} ` +
          "optional subdomain, confidence 0-1, importance 0-1, and any mentioned entities " +
          "(people, places, orgs, substances, foods). " +
          "Only extract facts from candidate_events. " +
          "recent_events is prior conversational context for pronoun resolution and topical " +
          "flow — use it to interpret candidate_events, but DO NOT extract facts from it. " +
          "session_summary is a rolling synopsis of the conversation up to recent_events; use " +
          "it for long-range context but DO NOT re-extract facts it already covers. " +
          "long_term_memory holds facts already known about the user across all sessions; use " +
          "it to avoid duplicating knowledge the system already has. " +
          "If an entity matches one of the entities referenced in long_term_memory (by name or " +
          "clear reference), set existing_id to the matching id; otherwise omit existing_id " +
          "(= new entity). " +
          "Return strictly {facts: [...]}.",
        {
          session_summary: sessionSummary ?? null,
          long_term_memory: (longTermMemory ?? []).map((f) => ({
            id: f.id,
            content: f.content,
            domain: f.domain,
          })),
          recent_events: workingMemory.map((e) => ({ role: e.role, content: e.content })),
          candidate_events: events.map((e) => ({ role: e.role, content: e.content })),
        },
        STAGE_1_SCHEMA,
      );

      if (!result || !Array.isArray(result.facts)) {
        return fallback.extractFactsFromEvents(
          events,
          workingMemory,
          sessionSummary,
          longTermMemory,
        );
      }

      const extracted: ExtractedFact[] = result.facts.map((f) => ({
        content: f.content,
        domain_hint: f.domain,
        subdomain_hint: f.subdomain ?? null,
        confidence_signal: typeof f.confidence === "number" ? f.confidence : null,
        importance_signal: typeof f.importance === "number" ? f.importance : null,
        capture_context: f.capture_context ?? null,
        valid_from: f.valid_from ?? null,
        valid_until: f.valid_until ?? null,
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
      return extracted;
    },

    async classifyFacts(facts, sessionContext) {
      // Classification is folded into stage 1 for inferred facts via
      // domain_hint. For explicit facts without a hint, delegate to heuristic.
      return fallback.classifyFacts(facts, sessionContext);
    },

    async extractEntities(facts) {
      // Entities come from stage 1 via session_facts.entities_json — see
      // consolidate.ts. For facts without pre-extracted entities (e.g. explicit
      // capture_fact entries), fall back to heuristic.
      return fallback.extractEntities(facts);
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

    async summarise(sessionFacts, graduatedFacts, priorSummary) {
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
          "first consolidation). Produce a CUMULATIVE summary that folds what was just learned " +
          "(graduated) into prior_summary — one natural paragraph, not a diff. " +
          "List up to 5 open threads — questions or follow-ups the user might want revisited. " +
          "Return strictly {summary, openThreads}.",
        {
          prior_summary: priorSummary ?? null,
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
