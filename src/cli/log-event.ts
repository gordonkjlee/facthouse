/**
 * log-event CLI command — inserts a SessionEvent directly into the database.
 * Used by Claude Code hooks to pipe conversation messages to OpenMemory.
 */

import path from "node:path";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { applySchema } from "../db/schema.js";
import { getLatestSession, insertEvent } from "../db/sessions.js";
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
 * Insert a session event via the CLI.
 * Opens the database, inserts the event, and closes. Stateless.
 *
 * @throws If no sessions exist and no sessionId is provided.
 */
export function logEvent(args: LogEventArgs): SessionEvent {
  const dbPath = path.join(args.dataDir, "knowledge.db");
  const db = openDatabase(dbPath);

  try {
    applySchema(db);

    const sessionId = args.sessionId ?? getLatestSession(db)?.id;

    if (!sessionId) {
      throw new Error(
        "No sessions found. Start the OpenMemory MCP server first to create a session.",
      );
    }

    return insertEvent(db, {
      session_id: sessionId,
      event_type: args.eventType,
      role: args.role,
      content: args.content,
      content_type: args.contentType ?? "text",
    });
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Stdin helpers for Claude Code hooks
// ---------------------------------------------------------------------------

/** Known hook payload field names for content extraction. */
const HOOK_CONTENT_FIELDS: Record<string, string> = {
  UserPromptSubmit: "prompt",
  Stop: "last_assistant_message",
};

/**
 * Extract content from a Claude Code hook JSON payload on stdin.
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
