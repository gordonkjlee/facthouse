/**
 * MCP resources — automatically-loaded context.
 *
 * Tools require the AI to decide to call them; resources are loaded by the
 * client without a decision. That is the whole point of these two: a session
 * starts with the user's context present, rather than depending on the model
 * remembering to go looking for it.
 *
 * Both are read-only computed views over the same database the read tools
 * query. `memory://profile` overlaps `get_profile` deliberately — the resource
 * is zero-friction, the tool is on-demand and parameterised. Clients without
 * resource support lose no capability, only convenience.
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
import { profileFacts } from "../search/profile.js";

export const PROFILE_URI = "memory://profile";
export const BRIEFING_URI = "memory://briefing";

/** Keep the briefing near the ~100 line budget it is specified to fit in. */
const PROFILE_LIMIT = 15;
const RECENT_LIMIT = 20;
const THREADS_LIMIT = 5;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function bullet(f: Fact): string {
  return `- ${f.content}`;
}

/** `memory://profile` — the user's identity facts as markdown. */
export function buildProfile(db: Db): string {
  const facts = profileFacts(db, 200);
  if (facts.length === 0) {
    return "# Profile\n\nNo profile facts captured yet.\n";
  }
  return `# Profile\n\n${facts.map(bullet).join("\n")}\n`;
}

/**
 * `memory://briefing` — profile, the last consolidation's narrative, open
 * threads, and recent changes. The one view an assistant should read at the
 * start of a session.
 */
export function buildBriefing(db: Db): string {
  const parts: string[] = ["# OpenMemory Briefing"];

  const profile = profileFacts(db, PROFILE_LIMIT);
  parts.push(
    "\n## Profile\n",
    profile.length
      ? profile.map(bullet).join("\n")
      : "Nothing known about the user yet.",
  );

  // The narrative comes from the last run that actually produced one: a run
  // records its row before the summary exists, and no-op runs never get one.
  const last = getLatestSummarised(db);
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

  // No domain filter -> most recently graduated facts across every domain.
  const recent = structuredSearch(db, { limit: RECENT_LIMIT });
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

  if (!profile.length && !last?.summary && !recent.length) {
    parts.push(
      "\nNo knowledge captured yet. Facts appear here once they have been captured and consolidated.",
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
export function registerResources(server: McpServer, db: Db): ResourceNotifier {
  const subscribed = new Set<string>();

  server.registerResource(
    "profile",
    PROFILE_URI,
    {
      title: "User profile",
      description:
        "The user's core identity facts — name, demographics, key personal details. Loaded automatically; no tool call needed.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: buildProfile(db) },
      ],
    }),
  );

  server.registerResource(
    "briefing",
    BRIEFING_URI,
    {
      title: "Memory briefing",
      description:
        "Everything worth knowing about the user right now: profile, what was learned in the last consolidation, open threads, and recent knowledge. Read this first — it is the fastest way to know who you are talking to.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: buildBriefing(db) },
      ],
    }),
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
