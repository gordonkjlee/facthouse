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
          `Filter to a specific domain (${routableDomainList()})`,
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
    `Get the user's core identity facts — name, demographics, key personal ` +
      `details.`,
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
    `Get the user's preferences.`,
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
    `Get everything known about a person — identity, relationship to user, ` +
      `preferences, facts.`,
    {
      name: z.string().describe("Person's name to look up"),
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
      `relationship traversal. More comprehensive than search_knowledge — ` +
      `follows entity connections.`,
    {
      topic: z.string().describe("Topic to explore"),
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
    `List available knowledge domains and their structure.`,
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
    `Get knowledge base statistics — fact count, entity count, domain ` +
      `distribution.`,
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
