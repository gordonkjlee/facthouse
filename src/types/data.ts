/**
 * Data model types for OpenMemory.
 *
 * This file implements the Data layer of the DIKW hierarchy — raw session
 * events captured as they happen, before any interpretation or consolidation.
 */

/**
 * MCP connection lifecycle — an open-ended container for events.
 *
 * One session = one MCP server process = one client connection. This is NOT
 * the same as a user session (web analytics), a conversation (agent/LLM), or
 * an episode (neuroscience). A conversation may span multiple sessions; a
 * session may contain multiple unrelated topics. Episodes are discovered at
 * consolidation by analysing topic continuity across events.
 */
export interface Session {
  id: string;
  source_tool: string | null;
  project: string | null;
  started_at: string;
  last_activity_at: string;
}

/**
 * A raw interaction within a session. Append-only.
 * Events are grouped into episodes at consolidation.
 */
export interface SessionEvent {
  id: string;
  session_id: string;
  sequence: number;
  event_type: "message" | "tool_call" | "tool_result" | "artifact";
  role: "user" | "assistant" | "system" | "tool";
  content_type: "text" | "json" | "image" | "audio" | "binary";
  content: string | null;
  /** URI or path for non-text content. Reference, not embed. */
  content_ref: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
