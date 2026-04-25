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
import type { Fact, SessionFact } from "../types/data.js";
import { DEFAULT_CONFIDENCE, DEFAULT_IMPORTANCE, type ServerConfig } from "../types/config.js";
import type {
  IntelligenceProvider,
  ClassifiedFact,
  ExtractedEntity,
} from "./types.js";
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
  getEntityById,
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

  // Capture the event watermark at run start — the highest session_events.sequence
  // observed. Stored on the consolidations row at commit time so the scheduler's
  // threshold check and extractFactsFromEvents both read a durable watermark,
  // regardless of whether any facts emerged from this run.
  const watermarkRow = db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) AS seq FROM session_events`)
    .get() as { seq: number };
  const runWatermark = watermarkRow.seq;

  // Previous watermark, used to decide whether an empty run is worth recording.
  // An empty run that doesn't advance the watermark is pure noise — subsequent
  // reads already see the same max(last_event_sequence) without our row.
  const prevWatermarkRow = db
    .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
    .get() as { seq: number };
  const prevWatermark = prevWatermarkRow.seq;

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
      // Only record an empty run when the watermark actually advances. This
      // prevents session_start (and other force-flushes) from spamming the
      // consolidations table with duplicate no-op rows when nothing new has
      // landed since the last run.
      if (runWatermark > prevWatermark) {
        db.prepare(
          `INSERT INTO consolidations
           (id, session_id, facts_in, facts_graduated, facts_rejected,
            entities_created, entities_linked, supersessions,
            summary, open_threads, last_event_sequence, created_at)
           VALUES (?, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?)`,
        ).run(consolidationId, runWatermark, new Date().toISOString());
      }
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

    // Step 1: Classify domains. For session_facts that carry a domain_hint
    // from extraction (set by CLI/sampling providers via subdomain_hint etc.),
    // trust that directly and don't re-call the classifier. Falls through to
    // the heuristic (or configured provider) for explicit-capture facts.
    const needsClassification = sessionFacts.filter((f) => !f.domain_hint);
    const autoClassified: ClassifiedFact[] = sessionFacts
      .filter((f) => f.domain_hint)
      .map((f) => ({
        id: f.id,
        content: f.content,
        domain: f.domain_hint!,
        subdomain: f.subdomain_hint ?? null,
      }));
    const explicitClassified = needsClassification.length
      ? await intelligence.classifyFacts(needsClassification)
      : [];
    const classified = [...autoClassified, ...explicitClassified];

    // Step 2: Build entity map. Prefer pre-extracted entities stored on the
    // session_fact (populated by the CLI provider's holistic extraction) —
    // saves an LLM call. Facts without entities_json go through the provider's
    // extractEntities path.
    const entityMap = new Map<string, ExtractedEntity[]>();
    const needsEntityExtraction: SessionFact[] = [];
    for (const sf of sessionFacts) {
      if (sf.entities_json) {
        try {
          const pre = JSON.parse(sf.entities_json) as ExtractedEntity[];
          if (Array.isArray(pre) && pre.length > 0) {
            entityMap.set(sf.id, pre);
            continue;
          }
        } catch {
          // Malformed JSON — fall through to provider extraction.
        }
      }
      needsEntityExtraction.push(sf);
    }
    if (needsEntityExtraction.length > 0) {
      const extracted = await intelligence.extractEntities(needsEntityExtraction);
      for (const [id, ents] of extracted.entries()) {
        entityMap.set(id, ents);
      }
    }

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
    /** Confidence boosts to apply to existing facts via Mem0's "enrich"
     *  reconcile decision — candidate is a paraphrase / corroboration of an
     *  existing fact, so instead of graduating we strengthen the existing one. */
    const enrichments: Array<{ existingFactId: string; confidenceDelta: number }> = [];
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

      if (decision.kind === "noop") {
        rejected++;
        continue;
      }

      if (decision.kind === "enrich") {
        // Validate the targeted ID is in our domain candidates. If the LLM
        // hallucinated an id, fall through to the add path as a safer default.
        const target = domainFacts.find((f) => f.id === decision.existingFactId);
        if (target) {
          enrichments.push({
            existingFactId: decision.existingFactId,
            confidenceDelta: 0.1,
          });
          rejected++;
          continue;
        }
        // else: hallucinated id → treat as add
      }

      seenBatchContent.add(normalised);
      // Confidence/importance: explicit captures carry their own values; for
      // inferred facts the extraction signals are the most informative input.
      // Precedence: explicit > LLM signal > default.
      const resolvedConfidence =
        sessionFact.confidence ??
        sessionFact.confidence_signal ??
        DEFAULT_CONFIDENCE;
      const resolvedImportance =
        sessionFact.importance ??
        sessionFact.importance_signal ??
        DEFAULT_IMPORTANCE;
      toGraduate.push({
        sessionFactId: cf.id,
        content: cf.content,
        domain: cf.domain,
        subdomain: cf.subdomain,
        confidence: resolvedConfidence,
        importance: resolvedImportance,
      });
    }

    // Determine the session_id for this consolidation run — used for the
    // consolidations row session_id column and to look up the prior rolling
    // session summary. Multi-session runs (rare; happens when consolidate
    // spans events from multiple sessions) get null.
    const uniqueSessionIds = new Set(sessionFacts.map((f) => f.session_id));
    const recordSessionId =
      uniqueSessionIds.size === 1 ? [...uniqueSessionIds][0] : null;

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

        // Capture context: prefer the LLM-derived hint over the explicit one.
        const captureContext =
          sessionFact.capture_context ?? null;

        // valid_from: prefer LLM-extracted timestamp when stated.
        const validFrom = sessionFact.valid_from_hint ?? undefined;

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
              capture_context: captureContext,
              source_quality: sessionFact.source_quality,
              valid_from: validFrom,
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
              capture_context: captureContext,
              source_quality: sessionFact.source_quality,
              valid_from: validFrom,
            });
        graduatedFacts.push(graduatedFact);

        // Link entities
        const extractedEntities = entityMap.get(item.sessionFactId);
        if (extractedEntities) {
          const factId = graduatedFact.id;
          const resolvedIds: string[] = [];

          for (const entity of extractedEntities) {
            let resolvedId: string | null = null;

            // LLM-resolved existing entity — validate the id, fall through if
            // hallucinated.
            if (entity.existing_id) {
              const existing = getEntityById(db, entity.existing_id);
              if (existing) resolvedId = existing.id;
            }

            if (!resolvedId) {
              const { entity: resolved, created } = findOrCreateEntity(db, {
                type: entity.type,
                name: entity.name,
              });
              if (created) entitiesCreated++;
              resolvedId = resolved.id;
            }

            resolvedIds.push(resolvedId);
            linkFactEntity(db, factId, resolvedId, entity.relationship);
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

      // Apply enrich decisions — boost existing facts' confidence (capped at 1.0)
      // for each paraphrase/corroboration the LLM identified.
      const enrichStmt = db.prepare(
        `UPDATE facts SET confidence = MIN(1.0, confidence + ?) WHERE id = ?`,
      );
      for (const e of enrichments) {
        enrichStmt.run(e.confidenceDelta, e.existingFactId);
      }

      // Insert consolidation record
      db.prepare(
        `INSERT INTO consolidations
         (id, session_id, facts_in, facts_graduated, facts_rejected,
          entities_created, entities_linked, supersessions,
          summary, open_threads, last_event_sequence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        runWatermark,
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

    // Look up the prior rolling session summary for this session — null when
    // this is the first consolidation of the session, or when the run spans
    // multiple sessions (recordSessionId is null in that case).
    const priorSessionSummary = recordSessionId
      ? (db
          .prepare(
            `SELECT summary FROM consolidations
             WHERE session_id = ? AND id != ? AND summary IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 1`,
          )
          .get(recordSessionId, consolidationId) as { summary: string } | undefined)?.summary ??
        null
      : null;

    // Generate summary (non-critical — don't lose a successful consolidation on failure)
    let summaryText: string | null = null;
    let threads: string[] = [...conflictMessages];
    try {
      const summaryResult = await intelligence.summarise(
        sessionFacts,
        graduatedFacts,
        priorSessionSummary,
      );
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
  const workingMemorySize = config?.extraction?.working_memory_size ?? 50;
  const maxContentLength = config?.extraction?.max_content_length ?? 2000;

  // Watermark is the highest session_events.sequence recorded on any previous
  // consolidation run. consolidate() writes this on every run (including empty
  // ones) so we don't stall when a batch produces zero facts.
  const watermarkRow = db
    .prepare(
      `SELECT MAX(last_event_sequence) AS max_seq FROM consolidations`,
    )
    .get() as { max_seq: number | null } | undefined;
  const watermark = watermarkRow?.max_seq ?? 0;

  // Load candidate events: everything since the watermark.
  const candidateRows = db
    .prepare(
      `SELECT * FROM session_events
       WHERE sequence > ?
       ORDER BY sequence ASC`,
    )
    .all(watermark) as any[];

  if (candidateRows.length === 0) return;

  const newEvents = candidateRows.map((e: any) => ({
    ...e,
    metadata: e.metadata ? JSON.parse(e.metadata) : null,
  }));

  // Determine the session id for attribution and working-memory scoping.
  // Prefer mcp_session_id (our own MCP connection); fall back to
  // client_session_id (hook-originated events from chat-only sessions).
  const sessionId =
    newEvents.find((e: any) => e.mcp_session_id)?.mcp_session_id ??
    newEvents.find((e: any) => e.client_session_id)?.client_session_id ??
    null;
  if (!sessionId) {
    return;
  }

  // Working memory: pre-watermark events from THE SAME session, capped at
  // workingMemorySize (default 50). Recent conversational context for
  // pronoun resolution and topical flow in the candidate events.
  const workingMemoryRows = db
    .prepare(
      `SELECT * FROM session_events
       WHERE sequence <= ?
         AND (mcp_session_id = ? OR client_session_id = ?)
       ORDER BY sequence DESC
       LIMIT ?`,
    )
    .all(watermark, sessionId, sessionId, workingMemorySize) as any[];
  const workingMemory = workingMemoryRows
    .map((e: any) => ({
      ...e,
      metadata: e.metadata ? JSON.parse(e.metadata) : null,
    }))
    .reverse(); // chronological order

  // Session summary: the rolling summary from the latest prior consolidation
  // for THIS session. Long-range conversational memory that survives beyond
  // the working_memory_size window. Null on the first consolidation in a
  // session — providers fall back to recent_events alone.
  const priorSummaryRow = db
    .prepare(
      `SELECT summary FROM consolidations
       WHERE session_id = ? AND summary IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as { summary: string | null } | undefined;
  const priorSummary = priorSummaryRow?.summary ?? null;

  // Long-term memory: currently-active graduated facts. Cross-session
  // background knowledge that helps the LLM avoid re-extracting facts the
  // system already has and resolve references not established in this
  // session. Empty when the K-layer hasn't been seeded yet.
  const longTermMemory = db
    .prepare(
      `SELECT * FROM facts
       WHERE status = 'active' AND is_latest = 1
         AND (valid_until IS NULL OR valid_until > datetime('now'))`,
    )
    .all()
    .map((row: any) => ({ ...row, is_latest: row.is_latest === 1 })) as Fact[];

  // Truncate long content for extraction.
  const truncated = newEvents.map((e: any) => ({
    ...e,
    content:
      e.content && e.content.length > maxContentLength
        ? e.content.slice(0, maxContentLength)
        : e.content,
  }));

  // Extract facts via intelligence provider.
  const extracted = await intelligence.extractFactsFromEvents(
    truncated,
    workingMemory,
    priorSummary,
    longTermMemory,
  );

  // Attribute the extracted session_facts to the session we already
  // identified above (used for working-memory scoping). This is the same
  // session id throughout — chat-only sessions with no MCP tool calls fall
  // back to client_session_id naturally via the lookup at the top.
  for (const item of extracted) {
    const fact = insertSessionFact(db, {
      session_id: sessionId,
      content: item.content,
      source_origin: "inferred",
      domain_hint: item.domain_hint,
      subdomain_hint: item.subdomain_hint ?? null,
      confidence_signal: item.confidence_signal ?? null,
      importance_signal: item.importance_signal ?? null,
      capture_context: item.capture_context ?? null,
      valid_from_hint: item.valid_from ?? null,
      valid_until_hint: item.valid_until ?? null,
      entities_json: item.entities ? JSON.stringify(item.entities) : null,
      source_quality: item.source_quality ?? "heuristic",
      consolidation_id: consolidationId,
    });

    if (fact) {
      // Primary link: events whose content literally contains the fact text.
      // Works for heuristic (which extracts substrings) but not for LLM
      // providers that paraphrase. If substring matching finds nothing, fall
      // through to a contextual link against every new event in the window —
      // lossy but preserves provenance so the fact isn't orphaned.
      let linkedPrimary = false;
      for (const event of newEvents) {
        if (event.content && event.content.includes(item.content)) {
          linkFactSource(db, {
            session_fact_id: fact.id,
            event_id: event.id,
            relevance: 0.8,
            extraction_type: "primary",
          });
          linkedPrimary = true;
        }
      }
      if (!linkedPrimary) {
        for (const event of newEvents) {
          linkFactSource(db, {
            session_fact_id: fact.id,
            event_id: event.id,
            relevance: 0.3,
            extraction_type: "contextual",
          });
        }
      }
    }
  }
}

