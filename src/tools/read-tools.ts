/**
 * Read tools — search and retrieve graduated knowledge.
 */

import type { Db } from "../db/connection.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch, searchWithProvider } from "../search/index.js";
import type { VectorSearchOpts } from "../search/vector.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import { findEntity, getEntityEdges } from "../db/entities.js";
import { getFactsByEntity, parseSystemTime } from "../db/facts.js";
import { lookupNamedSubject } from "../search/entity.js";
import { getDomains } from "../db/domains.js";
import { getStats } from "../db/stats.js";
import type { InterlocutorConfig, TemporalConfig } from "../types/config.js";
import { systemTimeWarning } from "../config.js";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReadTools(
  server: McpServer,
  db: Db,
  /** Null when semantic search is off, which is the shipped default. */
  embedding: EmbeddingProvider | null = null,
  /** How much of the semantic ranking survives. Store-configured. */
  tuning?: VectorSearchOpts,
  /**
   * Temporal mode. Bi-temporal exposes `as_of_system_time` on search;
   * simple (the default) omits it so the tool description costs no extra tokens.
   */
  temporal?: TemporalConfig,
  interlocutor?: InterlocutorConfig,
): void {
  const bitemporal = temporal?.mode === "bitemporal";
  // -----------------------------------------------------------------
  // search_knowledge
  // -----------------------------------------------------------------
  const searchDescription =
    `Search the knowledge base. Call this BEFORE answering ` +
    `questions that might benefit from what this store knows. If you have not ` +
    `called get_session_context (or loaded memory://briefing) this conversation, ` +
    `do that first — otherwise you start without this store's context. Returns facts ` +
    `ranked by relevance with source attribution and confidence scores.\n\n` +
    `Three fields come back. \`results\` is integrated knowledge: deduplicated, ` +
    `reconciled against everything else known, entities resolved. Each result ` +
    `carries speaker_role when the primary event is known (user, assistant, ` +
    `system, or tool) and speaker when the transcript named the person — ` +
    `who uttered it, not who it is about. \`pending\` ` +
    `is what was captured recently and not yet consolidated — real, and ` +
    `usually the most recent thing you were told, but not yet checked against ` +
    `existing knowledge, so it may duplicate or contradict a fact in results. ` +
    `Trust results first; use pending to avoid forgetting something you were ` +
    `told minutes ago. \`episodes\` is filled only when results are empty: a ` +
    `short raw-log window around a keyword hit in the pulled transcript, not ` +
    `yet extracted. It is not knowledge of the same standing — do not report ` +
    `it as a graduated fact.

` +
    `When semantic search is enabled, \`results\` also matches on meaning, so a ` +
    `query can surface a fact that shares none of its words. \`pending\` and ` +
    `\`episodes\` never do — they are keyword-only. A just-captured fact is ` +
    `findable by its own words but not yet by a paraphrase of them.` +
    (bitemporal
      ? `\n\nThis store records when the system retracted a belief. When you ` +
        `need what it believed at a past instant — not what is true now, and ` +
        `not when a fact was true in the world — pass as_of_system_time as an ` +
        `ISO 8601 instant. Superseded facts the system still held then come ` +
        `back; facts it learned afterwards do not. Omit it for current ` +
        `knowledge, which is almost always what you want. Queries before this ` +
        `store switched on that recording may be incomplete; the response then ` +
        `includes system_time_warning.`
      : "");

  const searchSchema = {
    query: z.string().describe("What to search for"),
    domain: z
      .string()
      .optional()
      .describe(
        `Prioritise a domain. Domains are whatever this store uses — they are ` +
          `not a fixed list, so call get_schemas to see them rather than ` +
          `guessing. This biases ranking rather than filtering: facts in the ` +
          `domain are surfaced and rank higher, but a strong match elsewhere ` +
          `still appears. Domains are assigned by a classifier and are ` +
          `approximate, so a hard filter would hide a fact filed under a ` +
          `near-synonym. Omit it to search everything.`,
      ),
    ...(bitemporal
      ? {
          as_of_system_time: z
            .string()
            .optional()
            .describe(
              `ISO 8601 instant (e.g. 2026-03-15T12:00:00Z). Returns facts ` +
                `the system believed at that instant, including ones it later ` +
                `superseded. Omit for current knowledge.`,
            ),
        }
      : {}),
  };

  server.tool(
    "search_knowledge",
    searchDescription,
    searchSchema,
    async (args) => {
      const rawAsOf =
        bitemporal &&
        "as_of_system_time" in args &&
        typeof args.as_of_system_time === "string"
          ? args.as_of_system_time
          : undefined;
      const asOfSystemTime = rawAsOf ? parseSystemTime(rawAsOf) : undefined;
      const response = await searchWithProvider(db, args.query, embedding, {
        domain: args.domain,
        tuning,
        asOfSystemTime,
        interlocutor,
      });
      if (asOfSystemTime) {
        response.system_time_warning = systemTimeWarning(
          asOfSystemTime,
          temporal?.bitemporal_since ?? null,
        );
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response) },
        ],
      };
    },
  );

  // get_profile and get_preferences were removed. Both selected a fixed domain
  // ('profile', 'preferences') on an engine that ships no vocabulary — so they
  // returned nothing for any store that does not happen to use those names, and
  // named the engine after one use case. Their value is served universally
  // elsewhere: the memory://briefing resource is the cue-less session-start
  // digest (importance-ranked, vocabulary-agnostic), and search_knowledge /
  // get_context / get_entity answer on-demand. "The user's preferences" is just
  // search_knowledge with a domain the store actually uses.

  // -----------------------------------------------------------------
  // get_entity
  // -----------------------------------------------------------------
  server.tool(
    "get_entity",
    `Get everything known about a named thing — who or what it is, the facts ` +
      `about it, and how it connects to other things.\n\n` +
      `A "thing" is any subject this store holds knowledge about: a person, an ` +
      `organisation, a project, a place, a product, a system — whatever the ` +
      `store is used for. This is the "tell me about X" tool.\n\n` +
      `Call this WHENEVER a named thing is mentioned or alluded to and knowing ` +
      `it would improve your answer — including indirect references like "my ` +
      `manager", "the Helsinki office", "the payments service". Call it before ` +
      `advising on anything involving that thing, and before asking who or what ` +
      `something is — you may already know.\n\n` +
      `Facts come back most relevant first, each flagged with is_subject. True ` +
      `means the fact is ABOUT this thing; false means it only mentions it. ` +
      `Treat the difference as real when you answer: "Alex's transfer was ` +
      `approved by Robin" is worth knowing when asked about Robin, but it is a ` +
      `fact about Alex, and reporting it as something you know about Robin ` +
      `would be wrong.\n\n` +
      `If this store has no entity by that exact name, facts that mention the ` +
      `wording still come back (is_subject false) rather than an empty miss. ` +
      `found is whether an entity row exists, not whether anything is known.`,
    {
      name: z
        .string()
        .describe(
          "The thing's name. Resolve an indirect reference to a name first " +
            "if you can (e.g. via get_context or a prior fact).",
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Optional type filter, only for disambiguation when one name refers " +
            "to two different things (a person and a project both called " +
            "'Mercury'). Types are whatever this store uses — omit it to match " +
            "any type, which is almost always what you want.",
        ),
    },
    async (args) => {
      // Type omitted matches any entity type. The engine ships no entity
      // vocabulary either — a corporate store's subjects are systems and
      // suppliers, not people — so defaulting to a fixed type would make most
      // subjects invisible to the one tool meant to find them.
      const lookup = await lookupNamedSubject(db, args.name, args.type);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              found: lookup.found,
              name: lookup.name,
              entity: lookup.entity,
              facts: lookup.facts,
              relationships: lookup.relationships,
            }),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------
  // get_context
  // -----------------------------------------------------------------
  server.tool(
    "get_context",
    `Get everything known about a topic, combining search with entity ` +
      `relationship traversal. More comprehensive than search_knowledge — it ` +
      `follows entity connections outward: from a named subject to the things ` +
      `it relates to, and the facts about those in turn.\n\n` +
      `Call this when you need the COMPLETE picture of a topic, subject, or ` +
      `domain rather than a specific fact — planning something involving a ` +
      `person, project or system, catching up on a subject, or answering an ` +
      `open-ended question about any of them.\n\n` +
      `Prefer search_knowledge when you want one fact fast; prefer this when ` +
      `missing a connection would make your answer wrong.`,
    {
      topic: z
        .string()
        .describe("Topic, person, project, or domain to explore"),
    },
    async (args) => {
      // Hybrid search for the topic
      const searchResponse = await hybridSearch(db, args.topic, { interlocutor });

      // Check if the topic matches an entity
      const entity = await findEntity(db, args.topic);
      const connectedFacts: Array<{
        entity_name: string;
        relationship: string;
        facts: Awaited<ReturnType<typeof getFactsByEntity>>;
      }> = [];

      if (entity) {
        // Sort edges by strength DESC — strongest relationships first.
        // This is a weighted 1-hop neighbour lookup, not spreading activation
        // (which would recursively propagate across multiple hops with decay).
        const edges = (await getEntityEdges(db, entity.id))
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 10);

        // Collect all connected entity IDs and batch-fetch names (avoids N+1)
        const connectedIds = edges.map((edge) =>
          edge.from_entity === entity.id ? edge.to_entity : edge.from_entity,
        );
        const nameMap = new Map<string, string>();
        if (connectedIds.length > 0) {
          const placeholders = connectedIds.map(() => "?").join(",");
          const rows = (await db
            .prepare(`SELECT id, name FROM entities WHERE id IN (${placeholders})`)
            .all(...connectedIds)) as Array<{ id: string; name: string }>;
          for (const row of rows) nameMap.set(row.id, row.name);
        }

        // Traverse edges to get connected entity facts
        for (const edge of edges) {
          const connectedEntityId =
            edge.from_entity === entity.id
              ? edge.to_entity
              : edge.from_entity;
          const facts = (await getFactsByEntity(db, connectedEntityId)).slice(0, 5);

          if (facts.length > 0) {
            connectedFacts.push({
              entity_name: nameMap.get(connectedEntityId) ?? connectedEntityId,
              relationship: edge.relationship,
              facts,
            });
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              search: searchResponse,
              entity: entity ?? null,
              connected: connectedFacts,
            }),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------
  // get_schemas
  // -----------------------------------------------------------------
  server.tool(
    "get_schemas",
    `List the knowledge domains this user's memory actually uses, and their ` +
      `subdomains. The set is not fixed — beyond the core domains it grows to ` +
      `fit the user, so it is worth asking rather than assuming.\n\n` +
      `Call this before filtering a search by domain, before choosing a ` +
      `domain_hint for capture_fact, or when you want to know how this user's ` +
      `knowledge is organised. Rarely needed mid-conversation — search_knowledge ` +
      `and get_context work without it.`,
    {},
    async () => {
      const domains = await getDomains(db);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ domains }),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------
  // get_stats
  // -----------------------------------------------------------------
  server.tool(
    "get_stats",
    `Get knowledge base statistics — how many facts are currently true, how ` +
      `many are held in total including superseded history, entity and domain ` +
      `counts, and how facts are distributed across domains.\n\n` +
      `Call this when the user asks what you know or remember about them, how ` +
      `much you have stored, or whether their memory is working. This answers ` +
      `"how much do you know", not "what do you know" — use search_knowledge, ` +
      `get_entity or get_context for actual recall.

` +
      `\`embeddings\` reports semantic-search coverage per model. An empty list ` +
      `means this store searches by keyword only, which is the default. A count ` +
      `well below the current fact count means some facts are findable by ` +
      `wording but not by meaning — worth mentioning if the user asks why ` +
      `something was not recalled.`,
    {},
    async () => {
      // Shared with `openmemory stats` so the tool and the CLI can't disagree.
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await getStats(db)) },
        ],
      };
    },
  );
}
