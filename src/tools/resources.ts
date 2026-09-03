/**
 * MCP resources — automatically-loaded context.
 *
 * Tools require the AI to decide to call them; resources are loaded by the
 * client without a decision. That is the whole point of these two: a session
 * starts with the user's context present, rather than depending on the model
 * remembering to go looking for it.
 *
 * Both are read-only computed views over the same database the read tools
 * query. Their lead section is the store's highest-importance facts — a
 * cue-less, always-available digest of what matters most, ranked by the store's
 * own importance calibration rather than by a fixed domain. That is what makes
 * them work for any store: a personal one surfaces identity and medical facts,
 * a corporate one surfaces incidents and clients, with no engine-side opinion.
 *
 * Content is markdown rather than JSON: it is injected into a model's context,
 * so it should read as prose, not as a payload to parse.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/connection.js";
import type { Fact } from "../types/data.js";
import { structuredSearch } from "../search/index.js";
import { getLatestSummarised } from "../db/consolidations.js";
import { keyFacts } from "../search/key-facts.js";
import { formatDiskBudget } from "../db/disk-budget.js";
import { getStats } from "../db/stats.js";
import { unexaminedEventCount } from "../db/extract-watermarks.js";
import { EXTRACT_CAP_EVENTS } from "../intelligence/steps.js";

// The URI keeps its historical name so existing subscribers do not break; the
// content is no longer domain-scoped. It is the store's key facts, whatever the
// store is about.
export const PROFILE_URI = "memory://profile";
export const BRIEFING_URI = "memory://briefing";

/**
 * How a tools-only client gets the briefing.
 *
 * `memory://briefing` is the right artefact. Cursor, Windsurf, and Grok never
 * fetch resources, so a session starts with no working set. This string is the
 * one instruction that closes the gap: MCP initialize `instructions`, and the
 * lead of `get_session_context`. Do not paste a third copy.
 */
export const SESSION_BOOTSTRAP_INSTRUCTIONS =
  "At the start of every conversation, before answering, call get_session_context " +
  "unless you already loaded the memory://briefing resource. That call returns the " +
  "same working briefing the resource would have injected. Tools-only clients never " +
  "fetch resources.";

/** Tool description for get_session_context. Lead is SESSION_BOOTSTRAP_INSTRUCTIONS. */
export function sessionContextDescription(): string {
  return (
    SESSION_BOOTSTRAP_INSTRUCTIONS +
    "\n\nAlso returns facts captured in this session that have not been " +
    "consolidated yet. Call it before re-capturing a fact you may have already " +
    "stored this session."
  );
}

/** Keep the briefing near the ~100 line budget it is specified to fit in. */
const KEY_FACTS_LIMIT = 15;
const RECENT_LIMIT = 20;
const THREADS_LIMIT = 5;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function bullet(f: Fact): string {
  return `- ${f.content}`;
}

async function pendingEventCount(db: Db): Promise<number> {
  return unexaminedEventCount(db);
}

async function consolidationRunCount(db: Db): Promise<number> {
  return ((await db.prepare(`SELECT COUNT(*) AS n FROM consolidations`).get()) as { n: number }).n;
}

/**
 * Next step when the store has no integrated facts. The profile is loaded by
 * the MCP client for the assistant — name the `consolidate` tool, not only
 * the CLI. Pending count is since the last watermark; extract is capped per
 * run, so a 5_000-event backfill is told it takes several runs or `--all`.
 */
async function emptyStoreNextStep(db: Db): Promise<string> {
  const pending = await pendingEventCount(db);
  if (pending > 0) {
    const capNote =
      pending <= EXTRACT_CAP_EVENTS
        ? " A later MCP session start will take this leftover."
        : ` More than ${EXTRACT_CAP_EVENTS} events wait; each run extracts that many oldest first, or run \`facthouse consolidate --all\`.`;
    return (
      "Nothing captured yet. Conversation events are waiting — call the " +
      "`consolidate` tool, or run `facthouse consolidate` from the CLI." +
      capNote
    );
  }
  if ((await consolidationRunCount(db)) > 0) {
    return (
      "Nothing captured yet. Events were processed but produced no facts — " +
      "heuristic extraction does not read transcripts. Use the claude CLI, then " +
      "call `consolidate` (or `facthouse consolidate`)."
    );
  }
  return (
    "Nothing captured yet. If this store has a named source, run " +
    "`facthouse consolidate` from the CLI, or call `consolidate`."
  );
}

/** `memory://profile` — the store's most important facts as markdown. */
export async function buildProfile(db: Db): Promise<string> {
  const facts = await keyFacts(db, 200);
  if (facts.length === 0) {
    return `# Key facts\n\n${await emptyStoreNextStep(db)}\n`;
  }
  return `# Key facts\n\n${facts.map(bullet).join("\n")}\n`;
}

/**
 * `memory://briefing` — the store's key facts, the last consolidation's
 * narrative, open threads, and recent changes. The one view an assistant should
 * read at the start of a session.
 */
export async function buildBriefing(db: Db): Promise<string> {
  const parts: string[] = ["# Facthouse Briefing"];

  const key = await keyFacts(db, KEY_FACTS_LIMIT);
  parts.push(
    "\n## Key facts\n",
    key.length
      ? key.map(bullet).join("\n")
      : await emptyStoreNextStep(db),
  );

  // The narrative comes from the last run that actually produced one: a run
  // records its row before the summary exists, and no-op runs never get one.
  const last = await getLatestSummarised(db);
  if (last?.summary) {
    parts.push(`\n## Last consolidation\n`, last.summary);
  }

  const threads = (last?.open_threads ?? []).slice(0, THREADS_LIMIT);
  if (threads.length) {
    parts.push(
      "\n## Open threads\n",
      threads.map((t) => `- ${t}`).join("\n"),
    );
  }

  // No domain filter -> most recently integrated facts across every domain.
  const recent = await structuredSearch(db, { limit: RECENT_LIMIT });
  if (recent.length) {
    parts.push(
      "\n## Recent knowledge\n",
      recent
        .map((f) => {
          const scope = f.subdomain ? `${f.domain}/${f.subdomain}` : f.domain;
          return `- **${scope}** — ${f.content}`;
        })
        .join("\n"),
    );
  }

  if (!key.length && !last?.summary && !recent.length) {
    parts.push(
      "\nNo knowledge captured yet. Facts appear here once they have been captured and consolidated.",
    );
  }

  const reclaim = (await getStats(db)).events.reclaimable;
  if (reclaim.events > 0) {
    parts.push(
      `\n${reclaim.events} raw events (${formatDiskBudget(reclaim.bytes)} of content) can be reclaimed with \`facthouse prune\`.`,
    );
  }

  return parts.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ResourceNotifier {
  /** Tell subscribed clients the resource content changed. Never throws. */
  notifyUpdated(): void;
  /** Currently-subscribed URIs. Exposed for tests. */
  subscriptions(): ReadonlySet<string>;
}

/**
 * Register both resources and the subscribe/unsubscribe handlers.
 *
 * MUST be called before `server.connect()` — registering a resource registers
 * the `resources` capability, and capabilities cannot change after a transport
 * is attached.
 *
 * The SDK ships `resources/subscribe` as a type but implements no handler, so
 * a client calling it would get MethodNotFound. We implement it here: content
 * changes on consolidation, and `resources/updated` is the notification that
 * says so. `resources/list_changed` would be wrong — the list of resources
 * never changes, only what they contain.
 */
export function registerResources(
  server: McpServer,
  db: Db,
  beforeRead?: () => Promise<void>,
): ResourceNotifier {
  const subscribed = new Set<string>();

  server.registerResource(
    "profile",
    PROFILE_URI,
    {
      title: "Key facts",
      description:
        "The most important facts this store holds, ranked by importance — the fastest cue-less way to see what matters here. Loaded automatically; no tool call needed.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      await beforeRead?.();
      return {
        contents: [
          { uri: uri.href, mimeType: "text/markdown", text: await buildProfile(db) },
        ],
      };
    },
  );

  server.registerResource(
    "briefing",
    BRIEFING_URI,
    {
      title: "Memory briefing",
      description:
        "The most important things this store knows right now: its key facts, what was learned in the last consolidation, open threads, and recent knowledge. Read this first — it is the fastest way to load context at the start of a session.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      await beforeRead?.();
      return {
        contents: [
          { uri: uri.href, mimeType: "text/markdown", text: await buildBriefing(db) },
        ],
      };
    },
  );

  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribed.add(req.params.uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  return {
    notifyUpdated() {
      for (const uri of subscribed) {
        // Rejects when no transport is attached — consolidation can finish
        // during shutdown. A failed notification must never surface as an
        // error: the data is already committed, and the scheduler swallows
        // throws anyway, which would hide a real one.
        void server.server.sendResourceUpdated({ uri }).catch(() => undefined);
      }
    },
    subscriptions: () => subscribed,
  };
}
