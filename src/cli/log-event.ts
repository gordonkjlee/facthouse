/**
 * log-event CLI command — inserts a SessionEvent directly into the database.
 * Used by AI client hooks to pipe conversation messages to OpenMemory.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { applySchema } from "../db/schema.js";
import {
  insertEvent,
  getLatestSession,
  createSession,
  ensureSession,
} from "../db/sessions.js";
import { sendSchedulerSignal } from "../ipc/scheduler-ipc.js";
import type { SessionEvent } from "../types/data.js";

export interface LogEventArgs {
  role: SessionEvent["role"];
  eventType: SessionEvent["event_type"];
  content: string;
  contentType?: SessionEvent["content_type"];
  sessionId?: string;
  dataDir: string;
}

/**
 * Insert an event via the CLI.
 * Opens the database, inserts the event, and closes. Stateless.
 *
 * When a sessionId is provided (e.g. from a hook payload), it is stored as
 * client_session_id. When it is not, the event is attached to the most recent
 * session, creating one if the store has none.
 *
 * That fallback is load-bearing, not tidiness, and it is **only** for this
 * command. `openmemory pull` writes `client_session_id` from the JSONL and
 * never calls `getLatestSession()` — two files in one pull stay two
 * conversations. Consolidation groups extraction by that id; an event with
 * both session columns null is examined and declined, not attached to
 * whatever was last active. Events used to be stored that way whenever no
 * session id was supplied, which meant the documented manual form
 * (`log-event --content "..."`) wrote rows that extraction skipped for ever,
 * with nothing reported at either end.
 *
 * After insertion, best-effort signals the running MCP server to tick the
 * scheduler. If the server isn't reachable (not running, different user
 * session, etc.), the signal is silently dropped — session_start on the
 * next server launch will pick up the event.
 *
 * Creates the data directory if it doesn't exist, mirroring what the server
 * does on boot. Hooks are the primary caller and can fire before the server
 * has ever run for a given data dir, in which case opening the database fails
 * and the event is lost — with the error going to a hook's stderr, where
 * nobody sees it.
 */
export async function logEvent(args: LogEventArgs): Promise<SessionEvent> {
  mkdirSync(args.dataDir, { recursive: true });
  const dbPath = path.join(args.dataDir, "memory.db");
  const db = openDatabase(dbPath);

  let event: SessionEvent;
  try {
    applySchema(db);

    // A hook-supplied id is the client's own, opaque to us — it goes in
    // client_session_id. Our fallback resolves a row in `sessions`, so it goes
    // in mcp_session_id, which also keeps last_activity_at current and makes
    // "most recent" mean something on the next call.
    const project = process.env.OPENMEMORY_PROJECT?.trim() || null;
    const mcpSessionId = args.sessionId
      ? null
      : resolveOwnSession(db, project);
    if (args.sessionId) {
      ensureSession(db, {
        id: args.sessionId,
        source_tool: "cli",
        project,
      });
    }

    event = insertEvent(db, {
      mcp_session_id: mcpSessionId,
      client_session_id: args.sessionId ?? null,
      event_type: args.eventType,
      role: args.role,
      content: args.content,
      content_type: args.contentType ?? "text",
    });
  } finally {
    closeDatabase(db);
  }

  // Signal the running MCP server. 500ms timeout internally; never throws.
  await sendSchedulerSignal(args.dataDir, "tick");
  return event;
}

/**
 * The session an event belongs to when the caller named none: the most recent
 * one, or a fresh one on a store that has never had a session.
 *
 * `source_tool: "cli"` records how the session came about, so a store seeded
 * from the command line is distinguishable from one an MCP client produced.
 * `project` is OPENMEMORY_PROJECT when set — the same env the MCP session
 * uses — provenance, not a tenant.
 */
function resolveOwnSession(
  db: ReturnType<typeof openDatabase>,
  project: string | null,
): string {
  const latest = getLatestSession(db);
  if (latest) {
    if (latest.project == null && project != null) {
      ensureSession(db, {
        id: latest.id,
        source_tool: latest.source_tool,
        project,
      });
    }
    return latest.id;
  }
  return createSession(db, { source_tool: "cli", project }).id;
}

// ---------------------------------------------------------------------------
// Stdin helpers for AI client hooks
// ---------------------------------------------------------------------------

/** Known hook payload field names for content extraction. */
const HOOK_CONTENT_FIELDS: Record<string, string> = {
  UserPromptSubmit: "prompt",
  Stop: "last_assistant_message",
};

/**
 * Extract content from an AI client hook JSON payload on stdin.
 * Returns the extracted text, or the raw input if not a known hook format.
 */
export function extractContentFromHookPayload(raw: string): {
  content: string;
  sessionId?: string;
} {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const hookEvent = payload.hook_event_name as string | undefined;

    // Try known hook fields first.
    if (hookEvent && hookEvent in HOOK_CONTENT_FIELDS) {
      const field = HOOK_CONTENT_FIELDS[hookEvent];
      const content = payload[field];
      if (typeof content === "string") {
        return {
          content,
          sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
        };
      }
    }

    // For PostToolUse or unknown hooks, stringify the whole payload.
    return {
      content: raw,
      sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
    };
  } catch {
    // Not JSON — use raw text.
    return { content: raw };
  }
}
