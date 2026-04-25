/**
 * log-event CLI command — inserts a SessionEvent directly into the database.
 * Used by AI client hooks to pipe conversation messages to OpenMemory.
 */

import path from "node:path";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { applySchema } from "../db/schema.js";
import { insertEvent } from "../db/sessions.js";
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
 * When a sessionId is provided (e.g. from a hook payload), it is stored
 * as client_session_id. Otherwise both session columns are null.
 *
 * After insertion, best-effort signals the running MCP server to tick the
 * scheduler. If the server isn't reachable (not running, different user
 * session, etc.), the signal is silently dropped — session_start on the
 * next server launch will pick up the event.
 */
export async function logEvent(args: LogEventArgs): Promise<SessionEvent> {
  const dbPath = path.join(args.dataDir, "memory.db");
  const db = openDatabase(dbPath);

  let event: SessionEvent;
  try {
    applySchema(db);

    event = insertEvent(db, {
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
