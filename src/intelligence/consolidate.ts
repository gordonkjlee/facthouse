/**
 * Consolidation pipeline — the core intelligence engine.
 * Performs both DIKW transitions in one atomic operation:
 *   D → Staging: Extract facts from raw events (if extraction enabled)
 *   Staging → Knowledge: Graduate session_facts through the full pipeline
 *
 * Loose analogy to human memory: rapid, context-rich capture during a session
 * is separated from a later batch consolidation phase that integrates new
 * information with prior knowledge. Not a model of hippocampal-cortical dynamics.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Fact } from "../types/data.js";
import { DEFAULT_CONFIDENCE, DEFAULT_IMPORTANCE, type ServerConfig } from "../types/config.js";
import type { IntelligenceProvider } from "./types.js";
import { normaliseForDedup } from "./heuristic.js";
import {
  claimForConsolidation,
  getClaimedFacts,
  insertSessionFact,
  linkFactSource,
} from "../db/session-facts.js";
import {
  insertFact,
  getFactsByDomain,
  supersedeFact,
} from "../db/facts.js";
import { createSource } from "../db/sources.js";
import {
  findOrCreateEntity,
  linkFactEntity,
  upsertEntityEdge,
} from "../db/entities.js";
import { ensureDomain } from "../db/domains.js";
import { acquireLock, releaseLock } from "../db/consolidation-lock.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ConsolidationResult {
  consolidationId: string;
  factsIn: number;
  factsGraduated: number;
  factsRejected: number;
  entitiesCreated: number;
  entitiesLinked: number;
  supersessions: number;
  summary: string | null;
  openThreads: string[];
  skipped: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function consolidate(
  db: Database.Database,
  intelligence: IntelligenceProvider,
  config?: Partial<ServerConfig>,
): Promise<ConsolidationResult> {
  const consolidationId = randomUUID();
  const extractionEnabled = config?.extraction?.enabled ?? false;

  // Phase A: Acquire lock
  const locked = acquireLock(db, consolidationId);
  if (!locked) {
    return {
      consolidationId,
      factsIn: 0,
      factsGraduated: 0,
      factsRejected: 0,
      entitiesCreated: 0,
      entitiesLinked: 0,
      supersessions: 0,
      summary: null,
      openThreads: [],
      skipped: true,
      skipReason: "Another consolidation is in progress",
    };
  }

  let phaseDCommitted = false;
  try {
    // Phase A: Claim pending session_facts
    claimForConsolidation(db, consolidationId);

    // Phase B: D→I event extraction (if enabled)
    if (extractionEnabled) {
      await extractFactsFromEvents(db, intelligence, consolidationId, config);
    }

    // Load all claimed facts (explicit + any newly inferred)
    const sessionFacts = getClaimedFacts(db, consolidationId);

    if (sessionFacts.length === 0) {
      releaseLock(db, consolidationId);
      return {
        consolidationId,
        factsIn: 0,
        factsGraduated: 0,
        factsRejected: 0,
        entitiesCreated: 0,
        entitiesLinked: 0,
        supersessions: 0,
        summary: null,
        openThreads: [],
        skipped: false,
      };
    }

    // Phase C: I→K graduation pipeline (LLM calls happen here, outside transaction)

    // Build lookup map for O(1) access in Phase C and D
    const sessionFactMap = new Map(sessionFacts.map((f) => [f.id, f]));

    // Step 1: Classify domains
    // sessionContext omitted — reserved for LLM-based providers.
    const classified = await intelligence.classifyFacts(sessionFacts);

    // Step 2: Extract entities holistically
    const entityMap = await intelligence.extractEntities(sessionFacts);

    // Domain cache shared between reconcile and supersession passes.
    // Domain scan gives both passes a consistent candidate pool and avoids re-fetching.
    // FTS5 would miss paraphrased duplicates (AND-semantics requires all terms to match).
    const domainCache = new Map<string, Fact[]>();
    const getDomainFacts = (domain: string): Fact[] => {
      let cached = domainCache.get(domain);
      if (!cached) {
        cached = getFactsByDomain(db, domain);
        domainCache.set(domain, cached);
      }
      return cached;
    };

    // Step 3: Reconcile each fact against existing knowledge
    const toGraduate: Array<{
      sessionFactId: string;
      content: string;
      domain: string;
      subdomain: string | null;
      confidence: number;
      importance: number;
    }> = [];
    let rejected = 0;
    // Intra-batch dedup: track normalised content already queued for graduation.
    // Without this, two session_facts with identical content from different sessions
    // both pass same-session hash dedup and both pass reconcile (neither has a graduated
    // twin yet), producing duplicate rows in the facts table.
    const seenBatchContent = new Set<string>();

    for (const cf of classified) {
      const sessionFact = sessionFactMap.get(cf.id);
      if (!sessionFact) continue;

      // Shared normalisation with cross-batch reconcile (heuristic.ts) so
      // "I prefer coffee" vs "I prefer coffee." is consistently handled.
      const normalised = normaliseForDedup(cf.content);
      if (seenBatchContent.has(normalised)) {
        rejected++;
        continue;
      }

      const domainFacts = getDomainFacts(cf.domain);
      const decision = await intelligence.reconcile(sessionFact, domainFacts);

      if (decision === "noop") {
        rejected++;
        continue;
      }

      seenBatchContent.add(normalised);
      toGraduate.push({
        sessionFactId: cf.id,
        content: cf.content,
        domain: cf.domain,
        subdomain: cf.subdomain,
        // TODO(confidence-modulation): confidence passes through unmodified from
        // capture time. Future: source boost (+0.1 for dual-sourced facts),
        // corroboration boost (+0.1 for independent corroboration), schema
        // consistency boost (+0.05). Requires an LLM-based provider to assess
        // source quality.
        confidence: sessionFact.confidence ?? DEFAULT_CONFIDENCE,
        importance: sessionFact.importance ?? DEFAULT_IMPORTANCE,
      });
    }

    // Step 4: Detect supersessions (outside transaction — may involve LLM)
    // Known limitation: supersession only checks new facts against EXISTING
    // graduated facts (from the domainCache populated above). Two facts in the
    // SAME batch cannot supersede each other. If a user captures "I prefer
    // coffee" then "I no longer prefer coffee" in one session, both graduate
    // as active facts. Fix: add an intra-batch supersession pass over
    // toGraduate before the write transaction.
    const supersessionMap = new Map<string, string>(); // sessionFactId → existingFactId to supersede
    const alreadySuperseded = new Set<string>(); // existingFactId already claimed by another candidate
    // Track supersession intents that were dropped because another candidate
    // in the same batch claimed the target first. Surfaced via openThreads so
    // the user knows their contradiction signal was partially lost.
    const droppedSupersessions: Array<{ newContent: string; targetedContent: string }> = [];

    // toGraduate is ordered by capture time (classifyFacts preserves input order).
    // First candidate to claim an existing fact wins — temporal priority.
    for (const item of toGraduate) {
      // Supersession is domain-scoped. FTS5 is the wrong tool here: it fails
      // when the new fact contains negation tokens ("no longer", "stopped")
      // that don't appear in the old fact. Use cached domain scan instead.
      const candidates = getDomainFacts(item.domain);
      const candidate = { id: item.sessionFactId, content: item.content, domain: item.domain, subdomain: item.subdomain };
      const result = await intelligence.detectSupersession(candidate, candidates);
      // Intentional: confidence is NOT compared here. A low-confidence new fact
      // with a clear negation marker ("I no longer prefer X") can supersede a
      // high-confidence prior. The negation signal is itself strong evidence
      // of a belief update; requiring confidence parity would make it impossible
      // for tentative corrections to update stale knowledge.
      if (result) {
        if (!alreadySuperseded.has(result.existingFactId)) {
          supersessionMap.set(item.sessionFactId, result.existingFactId);
          alreadySuperseded.add(result.existingFactId);
        } else {
          // Another candidate already claimed this target. This candidate will
          // graduate as a plain insert rather than a supersession — record the
          // conflict so it can surface in openThreads.
          const targeted = candidates.find((c) => c.id === result.existingFactId);
          droppedSupersessions.push({
            newContent: item.content,
            targetedContent: targeted?.content ?? result.existingFactId,
          });
        }
      }
    }
    const supersessionCount = supersessionMap.size;

    const graduatedFacts: Fact[] = [];

    // Phase D: Write results in a transaction
    const writeResults = db.transaction(() => {
      let entitiesCreated = 0;
      let entitiesLinked = 0;

      // Ensure all unique domains exist once, before the per-fact loop
      const uniqueDomains = new Set(toGraduate.map((item) => item.domain));
      for (const domain of uniqueDomains) {
        ensureDomain(db, domain);
      }

      for (const item of toGraduate) {
        const sessionFact = sessionFactMap.get(item.sessionFactId)!;

        // Write provenance source linking graduated fact back to its session_fact
        // (and through session_fact_sources, to the originating events).
        const source = createSource(db, {
          type: "session-fact",
          tool_id: sessionFact.source_tool,
          raw_content: sessionFact.content,
          metadata: {
            session_fact_id: sessionFact.id,
            session_id: sessionFact.session_id,
            source_origin: sessionFact.source_origin,
          },
        });

        const supersededId = supersessionMap.get(item.sessionFactId);

        const graduatedFact = supersededId
          ? supersedeFact(db, supersededId, {
              content: item.content,
              domain: item.domain,
              subdomain: item.subdomain,
              confidence: item.confidence,
              importance: item.importance,
              source_type: "conversation",
              source_tool: sessionFact.source_tool,
              source_id: source.id,
              session_id: sessionFact.session_id,
              capture_context: sessionFact.capture_context,
            })
          : insertFact(db, {
              content: item.content,
              domain: item.domain,
              subdomain: item.subdomain,
              confidence: item.confidence,
              importance: item.importance,
              source_type: "conversation",
              source_tool: sessionFact.source_tool,
              source_id: source.id,
              session_id: sessionFact.session_id,
              capture_context: sessionFact.capture_context,
            });
        graduatedFacts.push(graduatedFact);

        // Link entities
        const extractedEntities = entityMap.get(item.sessionFactId);
        if (extractedEntities) {
          const factId = graduatedFact.id;
          const resolvedIds: string[] = [];

          for (const entity of extractedEntities) {
            const { entity: resolved, created } = findOrCreateEntity(db, {
              type: entity.type,
              name: entity.name,
            });
            if (created) entitiesCreated++;
            resolvedIds.push(resolved.id);

            linkFactEntity(db, factId, resolved.id, entity.relationship);
            entitiesLinked++;
          }

          // Create entity-entity edges for co-occurring entities (using cached IDs).
          // co_mentioned is undirected — canonicalise by putting smaller id first
          // so (A, B) and (B, A) collapse to one row.
          for (let i = 0; i < resolvedIds.length; i++) {
            for (let j = i + 1; j < resolvedIds.length; j++) {
              const [a, b] = resolvedIds[i] < resolvedIds[j]
                ? [resolvedIds[i], resolvedIds[j]]
                : [resolvedIds[j], resolvedIds[i]];
              upsertEntityEdge(db, a, b, "co_mentioned");
            }
          }
        }
      }

      // Use the session_id only if all facts belong to one session; else NULL.
      // Consolidation runs are globally scoped and can span multiple sessions.
      const uniqueSessionIds = new Set(sessionFacts.map((f) => f.session_id));
      const recordSessionId = uniqueSessionIds.size === 1 ? [...uniqueSessionIds][0] : null;

      // Insert consolidation record
      db.prepare(
        `INSERT INTO consolidations
         (id, session_id, facts_in, facts_graduated, facts_rejected,
          entities_created, entities_linked, supersessions, summary, open_threads, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        consolidationId,
        recordSessionId,
        sessionFacts.length,
        toGraduate.length,
        rejected,
        entitiesCreated,
        entitiesLinked,
        supersessionCount,
        null, // summary filled below
        null,
        new Date().toISOString(),
      );

      return { entitiesCreated, entitiesLinked };
    })();
    phaseDCommitted = true;

    // Release lock before summary generation. summarise() is async on the
    // IntelligenceProvider interface — LLM-based providers make calls that
    // should not hold the advisory lock. If the process crashes between release
    // and the summary UPDATE, the consolidation record has summary=NULL, which
    // is acceptable (all facts are already graduated).
    releaseLock(db, consolidationId);

    // Build open threads from summary + any dropped supersessions
    const conflictMessages = droppedSupersessions.map(
      (d) =>
        `Conflict: "${d.newContent}" also targeted "${d.targetedContent}" for supersession but another candidate won. Graduated as an independent fact — review manually.`,
    );

    // Generate summary (non-critical — don't lose a successful consolidation on failure)
    let summaryText: string | null = null;
    let threads: string[] = [...conflictMessages];
    try {
      const summaryResult = await intelligence.summarise(sessionFacts, graduatedFacts);
      summaryText = summaryResult.summary;
      threads = [...conflictMessages, ...summaryResult.openThreads];
      db.prepare(
        `UPDATE consolidations SET summary = ?, open_threads = ? WHERE id = ?`,
      ).run(summaryText, JSON.stringify(threads), consolidationId);
    } catch {
      // Summary is non-critical — consolidation already succeeded.
      // Still persist conflict threads if any.
      if (conflictMessages.length > 0) {
        db.prepare(
          `UPDATE consolidations SET open_threads = ? WHERE id = ?`,
        ).run(JSON.stringify(conflictMessages), consolidationId);
      }
    }

    return {
      consolidationId,
      factsIn: sessionFacts.length,
      factsGraduated: toGraduate.length,
      factsRejected: rejected,
      entitiesCreated: writeResults.entitiesCreated,
      entitiesLinked: writeResults.entitiesLinked,
      supersessions: supersessionCount,
      summary: summaryText,
      openThreads: threads,
      skipped: false,
    };
  } catch (err) {
    // Only unclaim if Phase D hasn't committed — otherwise the facts are
    // already graduated and unclaiming would cause re-processing on the next run.
    if (!phaseDCommitted) {
      db.prepare(
        `UPDATE session_facts SET consolidation_id = NULL WHERE consolidation_id = ?`,
      ).run(consolidationId);
    }
    // Release lock on error if not already released
    releaseLock(db, consolidationId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Phase B: D→I event extraction
// ---------------------------------------------------------------------------

async function extractFactsFromEvents(
  db: Database.Database,
  intelligence: IntelligenceProvider,
  consolidationId: string,
  config?: Partial<ServerConfig>,
): Promise<void> {
  const contextOverlap = config?.extraction?.context_overlap ?? 5;
  const maxContentLength = config?.extraction?.max_content_length ?? 2000;

  // Get the highest event sequence already processed by inferred extraction.
  // Filter by source_origin='inferred' — auto-linked contextual sources from
  // explicit captures must not advance the watermark.
  // TODO(extraction): watermark stalls if a run extracts no facts.
  // Proper fix requires an extraction_watermarks table tracking processed events
  // independent of whether any facts were emitted.
  const watermarkRow = db
    .prepare(
      `SELECT MAX(e.sequence) AS max_seq
       FROM session_events e
       JOIN session_fact_sources sfs ON e.id = sfs.event_id
       JOIN session_facts sf ON sf.id = sfs.session_fact_id
       WHERE sf.source_origin = 'inferred'`,
    )
    .get() as { max_seq: number | null } | undefined;
  const watermark = watermarkRow?.max_seq ?? 0;

  // Load events since watermark
  const events = db
    .prepare(
      `SELECT * FROM session_events
       WHERE sequence > ?
       ORDER BY sequence ASC`,
    )
    .all(Math.max(0, watermark - contextOverlap)) as any[];

  if (events.length === 0) return;

  // Parse metadata
  const parsed = events.map((e: any) => ({
    ...e,
    metadata: e.metadata ? JSON.parse(e.metadata) : null,
  }));

  // Split into context (overlap) and new events
  const contextEvents = parsed.filter((e: any) => e.sequence <= watermark);
  const newEvents = parsed.filter((e: any) => e.sequence > watermark);

  if (newEvents.length === 0) return;

  // Truncate long content for extraction
  const truncated = newEvents.map((e: any) => ({
    ...e,
    content: e.content && e.content.length > maxContentLength
      ? e.content.slice(0, maxContentLength)
      : e.content,
  }));

  // Extract facts via intelligence provider
  const extracted = await intelligence.extractFactsFromEvents(truncated, contextEvents);

  // Write inferred session_facts.
  // TODO(extraction): all extracted facts are attributed to the first event's
  // mcp_session_id. Multi-session extraction needs per-event attribution (requires
  // extractFactsFromEvents to return source_event_ids alongside each fact).
  // TODO(extraction): substring-based source linking over-attributes when the
  // same phrase appears in multiple events, and UNDER-attributes for LLM-based providers
  // that paraphrase (event says "yeah I can't eat aspirin", extraction returns
  // "allergic to aspirin" → zero substring matches → unlinked orphan fact).
  // Fix: add source_event_ids to the extractFactsFromEvents return type.
  const sessionId =
    newEvents.find((e) => e.mcp_session_id)?.mcp_session_id ?? null;
  if (!sessionId) {
    // No event in this batch has an mcp_session_id — skip extraction silently.
    // Hook-originated events may have client_session_id only.
    return;
  }
  for (const item of extracted) {
    const fact = insertSessionFact(db, {
      session_id: sessionId,
      content: item.content,
      source_origin: "inferred",
      domain_hint: item.domain_hint,
      consolidation_id: consolidationId,
    });

    if (fact) {
      // Link to the source events
      for (const event of newEvents) {
        if (event.content && event.content.includes(item.content)) {
          linkFactSource(db, {
            session_fact_id: fact.id,
            event_id: event.id,
            relevance: 0.8,
            extraction_type: "primary",
          });
        }
      }
    }
  }
}

