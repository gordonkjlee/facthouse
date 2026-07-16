/**
 * Read tools — search and retrieve graduated knowledge.
 */

import type { Db } from "../db/connection.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch, structuredSearch } from "../search/index.js";
import { findEntity, getEntityEdges } from "../db/entities.js";
import { getFactsByEntity } from "../db/facts.js";
import { getDomains } from "../db/domains.js";
import { getStats } from "../db/stats.js";
import { routableDomainList } from "../schemas/domains.js";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReadTools(
  server: McpServer,
  db: Db,
): void {
  // -----------------------------------------------------------------
  // search_knowledge
  // -----------------------------------------------------------------
  server.tool(
    "search_knowledge",
    `Search the user's personal knowledge base. Call this BEFORE answering ` +
      `questions that might benefit from personal context — preferences, ` +
      `history, relationships, medical info, work context. Returns facts ` +
      `ranked by relevance with source attribution and confidence scores.`,
    {
      query: z.string().describe("What to search for"),
      domain: z
        .string()
        .optional()
        .describe(
          `Filter to a specific domain (${routableDomainList()}, or any other in use)`,
        ),
    },
    (args) => {
      const response = hybridSearch(db, args.query, {
        domain: args.domain,
      });

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response) },
        ],
      };
    },
  );

  // -----------------------------------------------------------------
  // get_profile
  // -----------------------------------------------------------------
  server.tool(
    "get_profile",
    `Get the user's core identity — who they are. Name, demographics, where ` +
      `they live, what they do.\n\n` +
      `Call this at the START of a conversation, before you address the user ` +
      `personally, and before any response that reads better for knowing who ` +
      `they are. Use this rather than search_knowledge when you want identity ` +
      `itself rather than a specific fact — it needs no query and returns the ` +
      `identity facts directly.\n\n` +
      `If it returns nothing, you genuinely know nothing about this user yet: ` +
      `say so rather than guessing, and capture what you learn.`,
    {},
    () => {
      const facts = structuredSearch(db, { domain: "profile" });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ domain: "profile", facts }),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------
  // get_preferences
  // -----------------------------------------------------------------
  server.tool(
    "get_preferences",
    `Get what the user likes, dislikes, and habitually chooses.\n\n` +
      `Call this BEFORE recommending, suggesting, ordering, booking, or ` +
      `choosing anything on the user's behalf — food, drink, tools, style, ` +
      `travel, scheduling. A recommendation made without checking is a guess, ` +
      `and the user has already told you the answer.\n\n` +
      `Also call it before assuming a default: if you are about to pick "the ` +
      `usual" option for them, check what their usual actually is.`,
    {
      // category parameter accepted but not used for filtering until a provider
      // populates subdomains. The heuristic provider always returns subdomain: null,
      // so filtering by category would always return zero results.
      category: z
        .string()
        .optional()
        .describe("Preference category (reserved for future use)"),
    },
    (args) => {
      const facts = structuredSearch(db, {
        domain: "preferences",
        // subdomain omitted: heuristic provider always returns null subdomains.
        // Passing args.category here would silently return empty results.
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              domain: "preferences",
              category: args.category ?? null,
              facts,
            }),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------
  // get_people
  // -----------------------------------------------------------------
  server.tool(
    "get_people",
    `Get everything known about a person in the user's life — who they are, ` +
      `their relationship to the user, facts about them, and their connections ` +
      `to other people.\n\n` +
      `Call this WHENEVER a person is named or alluded to and knowing them ` +
      `would improve your answer — including indirect references like "my ` +
      `partner", "my manager", "her birthday". Call it before advising on ` +
      `anything involving that person: a gift, a message, a plan, a conflict.\n\n` +
      `Look them up before asking the user who someone is — you may already ` +
      `know.`,
    {
      name: z
        .string()
        .describe(
          "Person's name. Resolve a relationship reference to a name first " +
            "if you can (e.g. via get_context or a prior fact).",
        ),
    },
    (args) => {
      const entity = findEntity(db, args.name, "person");

      if (!entity) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                found: false,
                name: args.name,
                facts: [],
                relationships: [],
              }),
            },
          ],
        };
      }

      const facts = getFactsByEntity(db, entity.id);
      const edges = getEntityEdges(db, entity.id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              found: true,
              entity,
              facts,
              relationships: edges,
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
      `follows entity connections outward (a named person → their relationship ` +
      `to the user → their preferences and history).\n\n` +
      `Call this when you need the COMPLETE picture of a topic, person, or ` +
      `domain rather than a specific fact — planning something involving ` +
      `someone, catching up on a subject, or answering an open-ended question ` +
      `about a person or project.\n\n` +
      `Prefer search_knowledge when you want one fact fast; prefer this when ` +
      `missing a connection would make your answer wrong.`,
    {
      topic: z
        .string()
        .describe("Topic, person, project, or domain to explore"),
    },
    (args) => {
      // Hybrid search for the topic
      const searchResponse = hybridSearch(db, args.topic);

      // Check if the topic matches an entity
      const entity = findEntity(db, args.topic);
      const connectedFacts: Array<{
        entity_name: string;
        relationship: string;
        facts: ReturnType<typeof getFactsByEntity>;
      }> = [];

      if (entity) {
        // Sort edges by strength DESC — strongest relationships first.
        // This is a weighted 1-hop neighbour lookup, not spreading activation
        // (which would recursively propagate across multiple hops with decay).
        const edges = getEntityEdges(db, entity.id)
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 10);

        // Collect all connected entity IDs and batch-fetch names (avoids N+1)
        const connectedIds = edges.map((edge) =>
          edge.from_entity === entity.id ? edge.to_entity : edge.from_entity,
        );
        const nameMap = new Map<string, string>();
        if (connectedIds.length > 0) {
          const placeholders = connectedIds.map(() => "?").join(",");
          const rows = db
            .prepare(`SELECT id, name FROM entities WHERE id IN (${placeholders})`)
            .all(...connectedIds) as Array<{ id: string; name: string }>;
          for (const row of rows) nameMap.set(row.id, row.name);
        }

        // Traverse edges to get connected entity facts
        for (const edge of edges) {
          const connectedEntityId =
            edge.from_entity === entity.id
              ? edge.to_entity
              : edge.from_entity;
          const facts = getFactsByEntity(db, connectedEntityId).slice(0, 5);

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
    () => {
      const domains = getDomains(db);

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
      `get_profile or get_context for actual recall.`,
    {},
    () => {
      // Shared with `openmemory stats` so the tool and the CLI can't disagree.
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(getStats(db)) },
        ],
      };
    },
  );
}
