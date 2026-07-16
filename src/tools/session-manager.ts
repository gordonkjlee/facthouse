/**
 * Session lifecycle management and event logging.
 * Provides the log_event MCP tool and the withEventLogging wrapper.
 */

import type { Db } from "../db/connection.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Session, SessionEvent } from "../types/data.js";
import {
  createSession as dbCreateSession,
  insertEvent,
  getSession,
  getEvents,
  getEventCount,
} from "../db/sessions.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SessionManager {
  /** The currently active session, or null if not yet started. */
  getActiveSession(): Session | null;

  /** Start a new session. Called from server.server.oninitialized. */
  startSession(sourceTool: string | null, project: string | null): Session;

  /**
   * Log an event in the current session.
   * Throws if no session has been started.
   */
  logEvent(opts: {
    event_type: SessionEvent["event_type"];
    role: SessionEvent["role"];
    content: string | null;
    content_type?: SessionEvent["content_type"];
    content_ref?: string | null;
    metadata?: Record<string, unknown> | null;
  }): SessionEvent;

  /** Register the log_event MCP tool on the server. */
  registerTools(server: McpServer): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionManager(
  db: Db,
  clientSessionId?: string | null,
): SessionManager {
  let activeSession: Session | null = null;

  const manager: SessionManager = {
    getActiveSession() {
      return activeSession;
    },

    startSession(sourceTool, project) {
      activeSession = dbCreateSession(db, {
        source_tool: sourceTool,
        project,
      });
      return activeSession;
    },

    logEvent(opts) {
      if (!activeSession) {
        throw new Error("No active session. Call startSession() first.");
      }

      const event = insertEvent(db, {
        mcp_session_id: activeSession.id,
        client_session_id: clientSessionId ?? null,
        event_type: opts.event_type,
        role: opts.role,
        content: opts.content,
        content_type: opts.content_type,
        content_ref: opts.content_ref,
        metadata: opts.metadata,
      });

      // Keep local copy in sync.
      activeSession = getSession(db, activeSession.id) ?? activeSession;

      return event;
    },

    registerTools(server) {
      server.tool(
        "log_event",
        `Record a raw exchange — a user message, your response, a tool call, a ` +
          `tool result, an artifact — as the episodic record consolidation later ` +
          `extracts facts from. Logging both sides gives that extraction the ` +
          `context to know what a reply refers to.\n\n` +
          `Where the client has hooks configured, every event is logged for you ` +
          `automatically and you do not need to call this at all. Call it when ` +
          `there are no hooks, or when an exchange matters enough to preserve ` +
          `verbatim — a decision, a correction, a specification — and you want it ` +
          `recorded whether or not hooks are running. Duplicates are reconciled ` +
          `at consolidation, so logging something twice is safe.\n\n` +
          `To store a fact you already know, use capture_fact instead: this tool ` +
          `records what was said, not what it means.`,
        {
          event_type: z
            .enum(["message", "tool_call", "tool_result", "artifact"])
            .describe("Type of event"),
          role: z
            .enum(["user", "assistant", "system", "tool"])
            .describe("Who produced this event"),
          content: z
            .string()
            .nullable()
            .describe("Text content of the event"),
          content_type: z
            .enum(["text", "json", "image", "audio", "binary"])
            .optional()
            .default("text")
            .describe(
              "How to interpret the content. Defaults to 'text' for messages. " +
                "Use 'json' for structured data, 'image' for screenshots or " +
                "generated images, 'audio' for voice or audio clips, 'binary' " +
                "for anything else non-text.",
            ),
          content_ref: z
            .string()
            .nullable()
            .optional()
            .describe("URI or path for non-text content"),
          metadata: z
            .record(z.unknown())
            .nullable()
            .optional()
            .describe("Arbitrary metadata"),
        },
        (args) => {
          const event = manager.logEvent({
            event_type: args.event_type,
            role: args.role,
            content: args.content,
            content_type: args.content_type,
            content_ref: args.content_ref,
            metadata: args.metadata,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  event_id: event.id,
                  sequence: event.sequence,
                }),
              },
            ],
          };
        },
      );
    },
  };

  return manager;
}

// ---------------------------------------------------------------------------
// Read tools — expose session events to calling AIs
// ---------------------------------------------------------------------------

/**
 * Register read tools for session events on the server.
 * Separated from SessionManager.registerTools so they can be wrapped
 * with withEventLogging independently.
 */
export function registerSessionReadTools(
  server: McpServer,
  manager: SessionManager,
  db: Db,
): void {
  server.tool(
    "get_events",
    `Retrieve events from the current or a previous session. Returns the raw ` +
      `episodic record — messages, tool calls, tool results, and artifacts in ` +
      `sequence order. Use this to recall what happened earlier in a conversation ` +
      `(especially after context compaction), or to review a previous session.`,
    {
      session_id: z
        .string()
        .optional()
        .describe(
          "Session to query (matches MCP or client session ID). " +
            "Omit for the current session.",
        ),
      after_sequence: z
        .number()
        .optional()
        .describe("Only return events after this sequence number (for pagination)."),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum events to return (default 50)."),
    },
    (args) => {
      const sessionId = args.session_id ?? manager.getActiveSession()?.id;
      if (!sessionId) {
        return {
          content: [{ type: "text" as const, text: "No active session." }],
          isError: true,
        };
      }

      const events = getEvents(db, sessionId, {
        after_sequence: args.after_sequence,
        limit: args.limit,
      });

      const total = getEventCount(db, sessionId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              session_id: sessionId,
              total_events: total,
              returned: events.length,
              events: events.map((e) => ({
                id: e.id,
                sequence: e.sequence,
                event_type: e.event_type,
                role: e.role,
                content: e.content,
                content_type: e.content_type,
                content_ref: e.content_ref,
                metadata: e.metadata,
                created_at: e.created_at,
              })),
            }),
          },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Tool callback wrapper — logs tool_call and tool_result events automatically
// ---------------------------------------------------------------------------

type ToolCallback = (...args: any[]) => any;

/**
 * Wrap a tool handler to automatically log tool_call and tool_result events.
 * Do NOT apply this to the log_event tool itself (infinite recursion).
 */
export function withEventLogging(
  manager: SessionManager,
  toolName: string,
  handler: ToolCallback,
): ToolCallback {
  const logError = (err: unknown) => {
    manager.logEvent({
      event_type: "tool_result",
      role: "tool",
      content: JSON.stringify({ error: String(err) }),
      content_type: "json",
      metadata: { tool: toolName, is_error: true },
    });
  };

  const logResult = (res: any) => {
    manager.logEvent({
      event_type: "tool_result",
      role: "tool",
      content: JSON.stringify(res),
      content_type: "json",
      metadata: { tool: toolName },
    });
    return res;
  };

  return (...args: any[]) => {
    // Log the tool call.
    manager.logEvent({
      event_type: "tool_call",
      role: "assistant",
      content: JSON.stringify({ tool: toolName, arguments: args[0] }),
      content_type: "json",
    });

    let result: any;
    try {
      result = handler(...args);
    } catch (err) {
      logError(err);
      throw err;
    }

    // Handle both sync and async handlers.
    if (result instanceof Promise) {
      return result.then(logResult, (err: unknown) => {
        logError(err);
        throw err;
      });
    }
    return logResult(result);
  };
}
