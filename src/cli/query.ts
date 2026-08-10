/**
 * search / stats CLI commands — read-only inspection of the knowledge base.
 *
 * Both are thin renderers over the same functions the MCP tools use
 * (`hybridSearch`, `getStats`), so what you see on the command line is exactly
 * what an AI client would see. They are the answer to "what does it actually
 * know about me?" without wiring up a client.
 *
 * Default output is human-readable; `--json` emits the raw tool payload for
 * scripting.
 */

import type { Db } from "../db/connection.js";
import { searchWithProvider } from "../search/index.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import { getStats, type KnowledgeStats } from "../db/stats.js";
import type { SearchResponse } from "../types/data.js";

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchArgs {
  query: string;
  domain?: string;
  limit?: number;
}

/** Run a hybrid search — the same call `search_knowledge` makes. */
export async function runSearch(
  db: Db,
  args: SearchArgs,
  /** Null when semantic search is off — the shipped default. */
  embedding: EmbeddingProvider | null = null,
  minSimilarityRatio?: number,
): Promise<SearchResponse> {
  // Same entry point the MCP tool uses, so the command line and an assistant
  // cannot get different answers to the same question.
  return searchWithProvider(db, args.query, embedding, {
    domain: args.domain,
    limit: args.limit,
    minSimilarityRatio,
  });
}

/** Render search results for a terminal. */
export function formatSearch(response: SearchResponse, query: string): string {
  if (response.results.length === 0) {
    const hint = response.suggested_refinement
      ? `\n\n${response.suggested_refinement}`
      : "";
    return `No knowledge found for "${query}".${hint}`;
  }

  const lines: string[] = [
    `${response.results.length} result${response.results.length === 1 ? "" : "s"} for "${query}"`,
    "",
  ];

  for (const r of response.results) {
    const f = r.fact;
    const scope = f.subdomain ? `${f.domain}/${f.subdomain}` : f.domain;
    lines.push(`  ${f.content}`);

    const meta = [
      scope,
      `score ${r.score.toFixed(3)}`,
      `confidence ${f.confidence.toFixed(2)}`,
    ];
    if (r.entities.length) {
      meta.push(`entities: ${r.entities.map((e) => e.name).join(", ")}`);
    }
    lines.push(`    ${meta.join("  ·  ")}`);
    lines.push("");
  }

  // Retrieval-quality signals — the same ones the tool hands an AI, so a thin
  // result set is visibly thin rather than silently wrong.
  lines.push(
    `  coverage ${(response.coverage_estimate * 100).toFixed(0)}%  ·  ` +
      `confidence ${(response.result_confidence * 100).toFixed(0)}%`,
  );
  if (response.suggested_refinement) {
    lines.push(`  ${response.suggested_refinement}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

/** Render knowledge base statistics for a terminal. */
export function formatStats(stats: KnowledgeStats): string {
  const lines: string[] = ["", "OpenMemory statistics", ""];

  lines.push(`  Facts           ${stats.facts.active_latest} current`);
  // Superseded facts are kept deliberately — history is never deleted — so the
  // gap between these two is meaningful rather than noise.
  const superseded = stats.facts.total - stats.facts.active_latest;
  if (superseded > 0) {
    lines.push(`                  ${stats.facts.total} total (${superseded} superseded)`);
  }
  lines.push(`  Entities        ${stats.entities}`);
  lines.push(`  Domains         ${stats.domains}`);
  lines.push(`  Consolidations  ${stats.consolidations}`);

  if (stats.domain_distribution.length) {
    lines.push("", "  By domain");
    const width = Math.max(...stats.domain_distribution.map((d) => d.domain.length));
    for (const d of stats.domain_distribution) {
      lines.push(`    ${d.domain.padEnd(width)}  ${d.count}`);
    }
  }

  if (stats.facts.total === 0) {
    lines.push("", "  Nothing captured yet.");
  }

  lines.push("");
  return lines.join("\n");
}

export { getStats };
