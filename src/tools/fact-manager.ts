/**
 * Knowledge capture and session-context recall tools.
 * Provides capture_fact (fast append-only capture buffer) and
 * get_session_context (retrieves facts captured in the current session).
 */

import type { Db } from "../db/connection.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionFact } from "../types/data.js";
import { type CaptureConfig, type ServerConfig } from "../types/config.js";
import type { SessionManager } from "./session-manager.js";
import type { IntelligenceProvider } from "../intelligence/types.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import {
  insertSessionFact,
  getUnconsolidatedSessionFacts,
  linkFactSource,
  speakerRoleOf,
} from "../db/session-facts.js";
import { getEventById } from "../db/sessions.js";
import {
  consolidate,
  type ConsolidationResult,
  type ConsolidatePhase,
} from "../intelligence/consolidate.js";
import { captureFactDescription } from "./capture-fact-description.js";
import {
  buildBriefing,
  sessionContextDescription,
} from "./resources.js";

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

  /** Run the consolidation pipeline. Default `full` (D→I then I→K). */
  runConsolidate(phase?: ConsolidatePhase): Promise<ConsolidationResult>;

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
  /** Null when semantic search is off — the shipped default. */
  embedding?: EmbeddingProvider | null;
  serverConfig?: Partial<ServerConfig>;
  /**
   * Called after a consolidation run commits, for runs that did work. Used to
   * tell subscribed clients that the computed resources have changed.
   *
   * Hooked here rather than at the scheduler because consolidation has two
   * entry points — the scheduler and the `consolidate` tool — and both funnel
   * through runConsolidate. Must not throw: consolidation has already
   * committed by this point, and the scheduler swallows exceptions, so a
   * throwing hook would be invisible.
   */
  onConsolidated?: (result: ConsolidationResult) => void;
  /**
   * This store's `config.sources`. Named sources → correction-only
   * capture_fact description; empty/omitted → proactive capture. The
   * description is the one instruction layer every client reads.
   */
  sources?: unknown;
}

export function createFactManager(
  db: Db,
  sessionManager: SessionManager,
  opts?: FactManagerOpts,
): FactManager {
  const defaultConfidence = opts?.captureConfig?.default_confidence ?? 0.7;
  const linkCount = opts?.autoLinkEvents ?? 5;
  const intelligence = opts?.intelligence;
  const embedding = opts?.embedding ?? null;
  const serverConfig = opts?.serverConfig;

  /**
   * Importance at capture is whatever the caller stated, or nothing.
   *
   * Capture cannot know a fact's domain — the classifier has not run — so it
   * cannot apply a domain's default. It used to try, keyed on the caller's
   * `domain_hint`, which callers rarely pass. Everything else resolves at
   * graduation, where the domain is known. Null means "not scored yet", which
   * is true.
   */
  function resolveImportance(explicit: number | null | undefined): number | null {
    return explicit ?? null;
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

      const importance = resolveImportance(input.importance);

      const sourceEvent = input.source_event_id
        ? getEventById(db, input.source_event_id)
        : null;

      const fact = insertSessionFact(db, {
        session_id: session.id,
        content: input.content,
        source_origin: "explicit",
        source_event_id: input.source_event_id ?? null,
        speaker_role: speakerRoleOf(sourceEvent?.role),
        speaker: sourceEvent?.speaker ?? null,
        domain_hint: input.domain_hint ?? null,
        confidence: input.confidence ?? defaultConfidence,
        // Left null when nothing knows yet — deliberately, and this is the
        // whole point. Stamping DEFAULT_IMPORTANCE here made the column
        // non-null forever, and graduation resolves
        // `importance ?? importance_signal ?? domain default ?? baseline`.
        // A non-null value short-circuits that chain at its first link, so both
        // the provider's LLM judgement and the domain's default were unreachable
        // for every explicit capture: everything scored 0.5, and "The user is
        // called Alex Rivera" ranked level with "Minor trivial detail".
        // resolveImportance already says "let downstream logic decide" — this
        // lets it.
        importance,
        source_tool: session.source_tool,
        capture_context: input.capture_context ?? null,
        // Facts captured deliberately by the AI/user via this tool are
        // 'explicit' regardless of which intelligence provider is active —
        // they didn't come from regex extraction or LLM inference.
        source_quality: "explicit",
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

    async runConsolidate(phase: ConsolidatePhase = "full") {
      if (!intelligence) {
        throw new Error("No intelligence provider configured for consolidation.");
      }
      const result = await consolidate(
        db,
        intelligence,
        serverConfig,
        embedding,
        phase,
      );

      // Skipped runs (lock contention, nothing pending) changed no knowledge,
      // so there is nothing for subscribers to re-read.
      if (!result.skipped && opts?.onConsolidated) {
        try {
          opts.onConsolidated(result);
        } catch {
          // A notification failure must never fail a committed consolidation.
        }
      }
      return result;
    },

    registerTools(server) {
      // ---------------------------------------------------------------
      // capture_fact
      // ---------------------------------------------------------------
      server.tool(
        "capture_fact",
        captureFactDescription(opts?.sources),
        {
          content: z.string().describe("The fact to capture"),
          domain_hint: z
            .string()
            .optional()
            .describe(
              "Suggested domain. Domains are whatever this store uses, not a " +
                "fixed list — call get_schemas to see them, reuse an existing one " +
                "where it fits, and propose a new short lowercase noun when none " +
                "does. Omit it and the server will classify.",
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
        sessionContextDescription(),
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
                  briefing: buildBriefing(db),
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
                      extraction_degraded: result.extractionDegraded === true,
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
