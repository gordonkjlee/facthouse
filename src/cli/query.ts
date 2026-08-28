/**
 * search / stats CLI commands — read-only inspection of the knowledge base.
 *
 * Both are thin renderers over the same functions the MCP tools use
 * (`hybridSearch`, `getStats`), so what you see on the command line is exactly
 * what an AI client would see. They are the answer to "what does it actually
 * know?" without wiring up a client.
 *
 * Default output is human-readable; `--json` emits the raw tool payload for
 * scripting.
 */

import type { Db } from "../db/connection.js";
import { searchWithProvider } from "../search/index.js";
import type { VectorSearchOpts } from "../search/vector.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import { getStats, type KnowledgeStats } from "../db/stats.js";
import type { EpisodeSlice, SearchResponse } from "../types/data.js";
import type { InterlocutorConfig } from "../types/config.js";

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchArgs {
  query: string;
  domain?: string;
  limit?: number;
  /** ISO 8601 instant; already parsed. Bi-temporal as-of-system-time read. */
  asOfSystemTime?: string;
}

/** Run a hybrid search — the same call `search_knowledge` makes. */
export async function runSearch(
  db: Db,
  args: SearchArgs,
  /** Null when semantic search is off — the shipped default. */
  embedding: EmbeddingProvider | null = null,
  tuning?: VectorSearchOpts,
  interlocutor?: InterlocutorConfig,
): Promise<SearchResponse> {
  // Same entry point the MCP tool uses, so the command line and an assistant
  // cannot get different answers to the same question.
  return await searchWithProvider(db, args.query, embedding, {
    domain: args.domain,
    limit: args.limit,
    asOfSystemTime: args.asOfSystemTime,
    tuning,
    interlocutor,
  });
}

/** Render search results for a terminal. */
export function formatSearch(response: SearchResponse, query: string): string {
  if (response.results.length === 0) {
    const episodes = response.episodes ?? [];
    if (episodes.length > 0) {
      return formatEpisodes(
        query,
        episodes,
        response.suggested_refinement,
        response.system_time_warning,
      );
    }
    const extras = [
      response.suggested_refinement,
      response.system_time_warning,
    ].filter(Boolean);
    const hint = extras.length > 0 ? `\n\n${extras.join("\n")}` : "";
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
    if (f.speaker) {
      meta.push(`speaker ${f.speaker}`);
    } else if (f.speaker_role) {
      meta.push(`speaker ${f.speaker_role}`);
    }
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
  if (response.system_time_warning) {
    lines.push(`  ${response.system_time_warning}`);
  }

  return lines.join("\n");
}

function formatEpisodes(
  query: string,
  episodes: EpisodeSlice[],
  refinement: string | null,
  systemTimeWarning?: string | null,
): string {
  const lines: string[] = [
    `No graduated facts for "${query}". Raw log window:`,
    "",
  ];
  for (const slice of episodes) {
    lines.push(`  conversation ${slice.conversation_id}`);
    for (const e of slice.events) {
      const mark = e.matched ? "*" : " ";
      const text = (e.content ?? "").replace(/\s+/g, " ").trim();
      lines.push(`  ${mark} [${e.role}] ${text}`);
    }
    lines.push("");
  }
  if (refinement) lines.push(`  ${refinement}`);
  if (systemTimeWarning) lines.push(`  ${systemTimeWarning}`);
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

  // Coverage, not just presence. A store can hold vectors for some of its
  // facts and search will still work — the semantic path ranks rather than
  // gates — so the number that matters is how many of the current facts are
  // reachable by meaning, which is only visible against the fact count.
  if (stats.embeddings.length) {
    lines.push("", "  Semantic coverage");
    for (const e of stats.embeddings) {
      const of = stats.facts.active_latest;
      const pct = of > 0 ? ` (${Math.round((e.count / of) * 100)}%)` : "";
      lines.push(`    ${e.model} @ ${e.dimensions}d  ${e.count}/${of}${pct}`);
    }
  }

  // Shown against the fact count, because the ratio is the finding. A store
  // whose raw layer is three orders of magnitude larger than its knowledge is
  // working correctly and still worth knowing about.
  if (stats.events.count > 0) {
    const mb = stats.events.bytes / 1048576;
    lines.push("", "  Raw events");
    lines.push(
      `    ${stats.events.count} logged` +
        (mb >= 0.1 ? `  (${mb.toFixed(1)} MB of content)` : ""),
    );
    if (mb >= 50) {
      lines.push(`    Reclaim what nothing can reach:  openmemory prune`);
    }
  }

  if (stats.facts.total === 0) {
    lines.push("", "  Nothing captured yet.");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render a prune report for a terminal.
 *
 * States what was spared as clearly as what would go. A user weighing an
 * irreversible delete needs to know the rule, not just the number — and the
 * commonest reason for a small result is that most events are still ahead of
 * the extraction watermark, which reads as "prune is broken" without a word of
 * explanation.
 */
export function formatPrune(
  stats: { events: number; bytes: number },
  applied: boolean,
  keepPerSession: number,
  vacuumed: boolean,
): string {
  const mb = (stats.bytes / 1048576).toFixed(1);
  const lines: string[] = ["", applied ? "Pruned raw events" : "Prune (dry run)", ""];

  if (stats.events === 0) {
    lines.push("  Nothing to reclaim.", "");
    lines.push("  An event is only removable once extraction has read it, no fact's");
    lines.push("  provenance points at it, and it has fallen out of its session's most");
    lines.push(`  recent ${keepPerSession} events. Anything newer is still in use.`, "");
    return lines.join("\n");
  }

  lines.push(
    `  ${applied ? "Removed" : "Removable"}  ${stats.events} events  (${mb} MB of content)`,
  );
  lines.push("");
  lines.push("  These have been read by extraction, are not cited as the provenance of");
  lines.push(`  any fact, and are older than the last ${keepPerSession} events of their session.`);
  lines.push("  No fact, entity or search result changes.");
  lines.push("");

  if (applied && !vacuumed) {
    lines.push("  The file will not shrink until the database is rebuilt:");
    lines.push("    openmemory prune --apply --vacuum");
    lines.push("  (VACUUM rewrites the whole database and needs comparable free disk.)");
  } else if (!applied) {
    lines.push("  Nothing has been deleted. To do it:");
    lines.push("    openmemory prune --apply --vacuum");
  }
  lines.push("");
  return lines.join("\n");
}

export { getStats };
