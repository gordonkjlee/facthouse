/**
 * Knowledge capture and session-context recall tools.
 * Provides capture_fact (fast append-only capture buffer) and
 * get_session_context (retrieves facts captured in the current session).
 */

import type Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionFact } from "../types/data.js";
import { DEFAULT_IMPORTANCE, type CaptureConfig, type ServerConfig } from "../types/config.js";
import type { SessionManager } from "./session-manager.js";
import type { IntelligenceProvider } from "../intelligence/types.js";
import {
  insertSessionFact,
  getUnconsolidatedSessionFacts,
  linkFactSource,
} from "../db/session-facts.js";
import { consolidate, type ConsolidationResult } from "../intelligence/consolidate.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface FactManager {
  /** Capture a fact into the session staging buffer. Returns null if duplicate. */
  captureFact(opts: {
    content: string;
    domain_hint?: string | null;
    confidence?: number | null;
    importance?: number | null;
    capture_context?: string | null;
    source_event_id?: string | null;
  }): SessionFact | null;

  /** Retrieve session facts for the current or specified session. */
  getSessionContext(sessionId?: string): SessionFact[];

  /** Run the consolidation pipeline. */
  runConsolidate(): Promise<ConsolidationResult>;

  /** Register capture_fact, get_session_context, and consolidate MCP tools. */
  registerTools(server: McpServer): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface FactManagerOpts {
  captureConfig?: Partial<CaptureConfig>;
  autoLinkEvents?: number;
  intelligence?: IntelligenceProvider;
  serverConfig?: Partial<ServerConfig>;
}

export function createFactManager(
  db: Database.Database,
  sessionManager: SessionManager,
  opts?: FactManagerOpts,
): FactManager {
  const importanceDefaults = opts?.captureConfig?.importance_defaults ?? {};
  const defaultConfidence = opts?.captureConfig?.default_confidence ?? 0.7;
  const linkCount = opts?.autoLinkEvents ?? 5;
  const intelligence = opts?.intelligence;
  const serverConfig = opts?.serverConfig;

  /** Resolve importance from: explicit > domain default > global default. */
  function resolveImportance(
    explicit: number | null | undefined,
    domainHint: string | null | undefined,
  ): number | null {
    if (explicit != null) return explicit;
    if (domainHint && domainHint in importanceDefaults) {
      return importanceDefaults[domainHint];
    }
    return null; // let the DB default or downstream logic decide
  }

  /** Auto-link to the last N events in the session as contextual sources. */
  function autoLinkRecentEvents(sessionFactId: string, sessionId: string): void {
    if (linkCount <= 0) return;

    // Match either column — events may be tagged with the MCP session id
    // (tool-originated) or the client session id (hook-originated). See schema v2.
    const rows = db
      .prepare(
        `SELECT id FROM session_events
         WHERE mcp_session_id = ? OR client_session_id = ?
         ORDER BY sequence DESC
         LIMIT ?`,
      )
      .all(sessionId, sessionId, linkCount) as Array<{ id: string }>;

    for (const row of rows) {
      linkFactSource(db, {
        session_fact_id: sessionFactId,
        event_id: row.id,
        relevance: 0.5,
        extraction_type: "contextual",
      });
    }
  }

  const manager: FactManager = {
    captureFact(input) {
      const session = sessionManager.getActiveSession();
      if (!session) {
        throw new Error("No active session. Call startSession() first.");
      }

      if (!input.content.trim()) {
        throw new Error("Fact content must not be empty.");
      }

      const importance = resolveImportance(input.importance, input.domain_hint);

      const fact = insertSessionFact(db, {
        session_id: session.id,
        content: input.content,
        source_origin: "explicit",
        source_event_id: input.source_event_id ?? null,
        domain_hint: input.domain_hint ?? null,
        confidence: input.confidence ?? defaultConfidence,
        importance: importance ?? DEFAULT_IMPORTANCE,
        source_tool: session.source_tool,
        capture_context: input.capture_context ?? null,
      });

      if (!fact) return null; // duplicate

      // Link explicit source first (primary takes priority over contextual)
      if (input.source_event_id) {
        linkFactSource(db, {
          session_fact_id: fact.id,
          event_id: input.source_event_id,
          relevance: 1.0,
          extraction_type: "primary",
        });
      }

      // Auto-link to recent events (INSERT OR IGNORE skips already-linked primary)
      autoLinkRecentEvents(fact.id, session.id);

      return fact;
    },

    getSessionContext(sessionId) {
      const id = sessionId ?? sessionManager.getActiveSession()?.id;
      if (!id) return [];
      return getUnconsolidatedSessionFacts(db, id);
    },

    async runConsolidate() {
      if (!intelligence) {
        throw new Error("No intelligence provider configured for consolidation.");
      }
      return consolidate(db, intelligence, serverConfig);
    },

    registerTools(server) {
      // ---------------------------------------------------------------
      // capture_fact
      // ---------------------------------------------------------------
      server.tool(
        "capture_fact",
        `Store a fact about the user. Call this proactively whenever you learn ` +
          `something useful for future conversations — preferences, personal details, ` +
          `medical information, relationships, work context, opinions, or decisions.\n\n` +
          `Capture is fast — the server stores the fact immediately. Entity extraction, ` +
          `domain classification, and cross-session reconciliation run in batch when ` +
          `you call consolidate. Capture frequently without slowing the conversation.\n\n` +
          `Exact same-session duplicates are dropped immediately. Cross-session exact ` +
          `duplicates are also rejected during the next consolidation run — safe to ` +
          `capture the same fact from multiple conversations without polluting the ` +
          `knowledge graph.`,
        {
          content: z.string().describe("The fact to capture"),
          domain_hint: z
            .string()
            .optional()
            .describe(
              "Suggested domain (profile, preferences, medical, people, work)",
            ),
          confidence: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("How confident (0.0–1.0)"),
          importance: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "How important (0.0–1.0). High for medical/safety, low for casual preferences",
            ),
          capture_context: z
            .string()
            .optional()
            .describe("What the conversation is about right now"),
          source_event_id: z
            .string()
            .optional()
            .describe("ID of the event that prompted this capture"),
        },
        (args) => {
          try {
            // Normalise domain_hint to prevent silent domain proliferation from
            // case/whitespace typos ("medicaL " → three silent sibling domains).
            const normalisedHint = args.domain_hint?.toLowerCase().trim() || undefined;
            const fact = manager.captureFact({
              content: args.content,
              domain_hint: normalisedHint,
              confidence: args.confidence,
              importance: args.importance,
              capture_context: args.capture_context,
              source_event_id: args.source_event_id,
            });

            if (!fact) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ duplicate: true }),
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    fact_id: fact.id,
                    session_id: fact.session_id,
                    content_hash: fact.content_hash,
                    duplicate: false,
                  }),
                },
              ],
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [
                { type: "text" as const, text: JSON.stringify({ error: message }) },
              ],
              isError: true,
            };
          }
        },
      );

      // ---------------------------------------------------------------
      // get_session_context
      // ---------------------------------------------------------------
      server.tool(
        "get_session_context",
        `Recall what you've captured in this conversation. Returns facts from the ` +
          `current session that haven't been consolidated yet.\n\n` +
          `Call this before re-capturing a fact you may have already stored this ` +
          `session — avoids duplicate capture. Also useful to review session state ` +
          `before calling consolidate.`,
        {
          session_id: z
            .string()
            .optional()
            .describe(
              "Session to query. Omit for the current session.",
            ),
        },
        (args) => {
          const facts = manager.getSessionContext(args.session_id);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  session_id:
                    args.session_id ??
                    sessionManager.getActiveSession()?.id ??
                    null,
                  count: facts.length,
                  facts: facts.map((f) => ({
                    id: f.id,
                    content: f.content,
                    domain_hint: f.domain_hint,
                    importance: f.importance,
                    capture_context: f.capture_context,
                    source_origin: f.source_origin,
                    created_at: f.created_at,
                  })),
                }),
              },
            ],
          };
        },
      );

      // ---------------------------------------------------------------
      // consolidate
      // ---------------------------------------------------------------
      if (intelligence) {
        server.tool(
          "consolidate",
          `Integrate captured knowledge into long-term memory. Extracts entities, ` +
            `resolves duplicates, detects contradictions with existing knowledge, ` +
            `and builds the knowledge graph.\n\n` +
            `Call this to integrate pending facts into long-term knowledge. Good ` +
            `checkpoints: after capturing several facts, at a topic change, or ` +
            `before the conversation ends.`,
          {},
          async () => {
            try {
              const result = await manager.runConsolidate();

              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      consolidation_id: result.consolidationId,
                      facts_in: result.factsIn,
                      facts_graduated: result.factsGraduated,
                      facts_rejected: result.factsRejected,
                      entities_created: result.entitiesCreated,
                      entities_linked: result.entitiesLinked,
                      supersessions: result.supersessions,
                      summary: result.summary,
                      skipped: result.skipped,
                      skip_reason: result.skipReason ?? null,
                    }),
                  },
                ],
              };
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify({ error: message }) },
                ],
                isError: true,
              };
            }
          },
        );
      }
    },
  };

  return manager;
}
