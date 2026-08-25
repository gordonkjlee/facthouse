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
import { withTransaction } from "../db/connection.js";
import type { Db } from "../db/connection.js";
import type {
  Fact,
  SessionEvent,
  SessionFact,
  TopicSegment,
} from "../types/data.js";
import { DEFAULT_CONFIDENCE, DEFAULT_IMPORTANCE, type ServerConfig } from "../types/config.js";
import type {
  IntelligenceProvider,
  ClassifiedFact,
  ExtractedEntity,
  ExtractedFact,
  ExtractionOutcome,
} from "./types.js";
import {
  EXTRACT_EVIDENCE_SLICE,
  EXTRACT_REREAD_CONFIDENCE,
  EXTRACT_REREAD_WINDOW,
  capReferents,
} from "./extract-prompt.js";
import { relatedFactsForExtract } from "./related-k.js";
import {
  latestConversationSituation,
  applySituation,
  NEWEST_CONSOLIDATION,
  type ConversationSituation,
} from "../db/consolidations.js";
import { normaliseForDedup } from "./heuristic.js";
import {
  claimForConsolidation,
  getClaimedFacts,
  insertSessionFact,
  linkFactSource,
} from "../db/session-facts.js";
import {
  conversationRef,
  type ConversationRef,
} from "../db/sessions.js";
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
  ensureSelfEntity,
  SUBJECT_OF,
} from "../db/entities.js";
import { isAboutTheUser } from "./subject.js";
import { ensureDomain } from "../db/domains.js";
import { importanceDefaults, normaliseDomainName } from "../schemas/domains.js";
import { acquireLock, releaseLock } from "../db/consolidation-lock.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import {
  getFactsMissingEmbeddings,
  insertEmbeddings,
} from "../db/embeddings.js";

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
  /**
   * The configured extractor could not run, so raw events were not examined and
   * the event watermark was held back for the next run to retry.
   *
   * Reported because the failure is otherwise invisible: facts captured
   * explicitly still graduate, so the run returns healthy-looking counts while
   * an entire batch of conversation went unread.
   */
  extractionDegraded?: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function consolidate(
  db: Db,
  intelligence: IntelligenceProvider,
  config?: Partial<ServerConfig>,
  /**
   * Optional — null means semantic search is off, which is the shipped default.
   * Passed in rather than constructed here so consolidation keeps no opinion
   * about providers, exactly as it keeps none about intelligence providers.
   */
  embeddingProvider: EmbeddingProvider | null = null,
): Promise<ConsolidationResult> {
  const consolidationId = randomUUID();
  const extractionEnabled = config?.extraction?.enabled ?? false;
  // Read from the vocabulary the user configured, not a separate map. Importance
  // is a property of a domain — a domain's calibration belongs with the domain,
  // and a second list keyed by name is one more thing to drift. Whoever owns the
  // vocabulary owns its calibration: a missed allergy is the costliest error in a
  // personal store, a missed SLA breach in a corporate one, and the engine cannot
  // know which it is looking at.
  const defaultsByDomain = importanceDefaults(config?.domains ?? []);

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

  // Set when the configured extractor could not run. The events it was meant to
  // read have not been examined, so the watermark must stay where it was and
  // leave them eligible for the next run. Advancing regardless is what made a
  // transient provider failure discard a batch of conversation for good.
  let extractionDegraded = false;
  let extractPending: ExtractPending[] = [];

  let phaseDCommitted = false;
  try {
    // Phase A: Claim pending session_facts
    claimForConsolidation(db, consolidationId);

    // Phase B: D→I event extraction (if enabled)
    if (extractionEnabled) {
      const extracted = await extractFactsFromEvents(
        db,
        intelligence,
        consolidationId,
        config,
      );
      extractionDegraded = extracted.degraded;
      extractPending = extracted.pending;
    }

    // Hold the watermark back rather than advancing past unexamined events.
    // Deliberately not `prevWatermark - 1` or similar: the goal is simply that
    // this run claims no new ground, so the next one sees the same candidates.
    const effectiveWatermark = extractionDegraded ? prevWatermark : runWatermark;

    // Load all claimed facts (explicit + any newly inferred)
    const sessionFacts = getClaimedFacts(db, consolidationId);

    if (sessionFacts.length === 0) {
      // Only record an empty run when the watermark actually advances. This
      // prevents session_start (and other force-flushes) from spamming the
      // consolidations table with duplicate no-op rows when nothing new has
      // landed since the last run.
      if (!extractionDegraded && runWatermark > prevWatermark) {
        const onlyId =
          extractPending.length === 1 ? extractPending[0].group.ref.id : null;
        db.prepare(
          `INSERT INTO consolidations
           (id, session_id, facts_in, facts_graduated, facts_rejected,
            entities_created, entities_linked, supersessions,
            summary, open_threads, last_event_sequence, created_at)
           VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?)`,
        ).run(
          consolidationId,
          onlyId,
          effectiveWatermark,
          new Date().toISOString(),
        );
        persistSituations(
          db,
          consolidationId,
          onlyId,
          extractPending,
          effectiveWatermark,
        );
      }
      // Backfill on the empty path too. This branch is "nothing new graduated",
      // which is exactly the state a store is in when it has a backlog and no
      // fresh input — semantic search switched on over an existing store, or a
      // previous run whose provider was down. Returning here without embedding
      // would mean the backlog only ever drains on runs that happen to have new
      // facts, which for a quiet store is never.
      await embedGraduatedFacts(db, embeddingProvider, config);

      releaseLock(db, consolidationId);
      return {
        consolidationId,
        extractionDegraded,
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
    // Canonicalise every domain's spelling, whatever produced it: a caller's
    // hint (which skips classification) or a provider's output. This merges
    // "Preferences" into "preferences" so one domain cannot exist twice.
    //
    // It deliberately does not coerce an unknown domain into `general`. The
    // taxonomy is open beyond the core, and the label a classifier chose is the
    // most distinctive thing about a fact that fits nothing else — discarding it
    // is the lossy step. Retrieval must therefore never depend on the label
    // matching exactly; see docs/design/data-model.md § Domains.
    const classified = [...autoClassified, ...explicitClassified].map((cf) => ({
      ...cf,
      domain: normaliseDomainName(cf.domain),
    }));

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
      // Resolution order, per data-model.md: the assistant's explicit value, a
      // provider's signal, the domain's default, then the neutral baseline.
      //
      // The domain default is applied HERE rather than at capture because this
      // is the first point the domain is actually known. capture_fact resolves
      // it from the caller's domain_hint, which callers rarely pass — so for an
      // ordinary capture the config layer never fired and everything landed on
      // DEFAULT_IMPORTANCE. Keying off the classified domain is what makes the
      // documented order real.
      const resolvedImportance =
        sessionFact.importance ??
        sessionFact.importance_signal ??
        defaultsByDomain[cf.domain] ??
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

    // The run row carries this id when every fact this batch belongs to one
    // conversation. Mixed batches leave it null — per-session rolling
    // summaries are written as satellite consolidations rows below, not
    // dropped.
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
    const writeResults = withTransaction(db, () => {
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

        // Mark the subject, where it can be known without guessing.
        //
        // Outside the `extractedEntities` branch above deliberately: a fact can
        // be about the user and name nobody at all ("The user prefers dark
        // mode"), which is precisely the fact that most needs an anchor and the
        // one an extractor returns nothing for.
        //
        // Only the deterministic case is handled here. Subject identification
        // in general is a model's job, and no provider emits it yet — a fact
        // about Robin will still carry only mention links until they do.
        if (isAboutTheUser(graduatedFact.content)) {
          linkFactEntity(db, graduatedFact.id, ensureSelfEntity(db).id, SUBJECT_OF);
          entitiesLinked++;
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
        effectiveWatermark,
        new Date().toISOString(),
      );

      return { entitiesCreated, entitiesLinked };
    });
    phaseDCommitted = true;

    // Phase E: embed the facts that just graduated, if semantic search is on.
    //
    // After the commit, deliberately. An embedding is derived data, and no
    // failure here may cost a fact: the provider is a network call or a local
    // service, and both fail in ways consolidation must survive. Facts are
    // already durable at this point, so the worst case is that they carry no
    // vector until the next run picks them up.
    //
    // Also outside the lock — like summarise() below, and for the same reason.
    await embedGraduatedFacts(db, embeddingProvider, config);

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

    // Generate summaries (non-critical — don't lose a successful consolidation
    // on failure). One conversation updates the run row. Several conversations
    // leave the run row as the watermark clock and write a satellite row per
    // session so the next extract of that id still has a rolling summary.
    let summaryText: string | null = null;
    let threads: string[] = [...conflictMessages];
    if (recordSessionId) {
      const priorSessionSummary = latestSessionSummary(
        db,
        recordSessionId,
        consolidationId,
      );
      try {
        persistSituations(
          db,
          consolidationId,
          recordSessionId,
          extractPending,
          effectiveWatermark,
        );
        const closed = closedGistsFor(extractPending, recordSessionId);
        const summaryResult = await intelligence.summarise(
          sessionFacts,
          graduatedFacts,
          priorSessionSummary,
          closed,
        );
        summaryText = summaryResult.summary;
        threads = [...conflictMessages, ...summaryResult.openThreads];
        db.prepare(
          `UPDATE consolidations SET summary = ?, open_threads = ? WHERE id = ?`,
        ).run(summaryText, JSON.stringify(threads), consolidationId);
      } catch {
        if (conflictMessages.length > 0) {
          db.prepare(
            `UPDATE consolidations SET open_threads = ? WHERE id = ?`,
          ).run(JSON.stringify(conflictMessages), consolidationId);
        }
      }
    } else {
      if (conflictMessages.length > 0) {
        db.prepare(
          `UPDATE consolidations SET open_threads = ? WHERE id = ?`,
        ).run(JSON.stringify(conflictMessages), consolidationId);
      }
      const situationRows = persistSituations(
        db,
        consolidationId,
        null,
        extractPending,
        effectiveWatermark,
      );
      for (const sessionId of uniqueSessionIds) {
        const factsFor = sessionFacts.filter((f) => f.session_id === sessionId);
        const graduatedFor = graduatedFacts.filter(
          (f) => f.session_id === sessionId,
        );
        const prior = latestSessionSummary(db, sessionId, consolidationId);
        const closed = closedGistsFor(extractPending, sessionId);
        try {
          const summaryResult = await intelligence.summarise(
            factsFor,
            graduatedFor,
            prior,
            closed,
          );
          const existingId = situationRows.get(sessionId);
          if (existingId) {
            db.prepare(
              `UPDATE consolidations SET summary = ?, open_threads = ? WHERE id = ?`,
            ).run(
              summaryResult.summary,
              JSON.stringify(summaryResult.openThreads),
              existingId,
            );
          } else {
            db.prepare(
              `INSERT INTO consolidations
               (id, session_id, facts_in, facts_graduated, facts_rejected,
                entities_created, entities_linked, supersessions,
                summary, open_threads, last_event_sequence, created_at)
               VALUES (?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              sessionId,
              summaryResult.summary,
              JSON.stringify(summaryResult.openThreads),
              effectiveWatermark,
              new Date().toISOString(),
            );
          }
        } catch {
          // Satellite summary is non-critical — the run row already advanced
          // the watermark and the facts are graduated.
        }
      }
    }

    return {
      consolidationId,
      extractionDegraded,
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

/** session_events row as SQLite returns it — metadata is still a JSON string. */
type SessionEventRow = Omit<SessionEvent, "metadata"> & { metadata: string | null };

function parseEventRow(row: SessionEventRow): SessionEvent {
  return {
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}

function latestSessionSummary(
  db: Db,
  sessionId: string,
  excludeId?: string,
): string | null {
  const row = excludeId
    ? (db
        .prepare(
          `SELECT summary FROM consolidations
           WHERE session_id = ? AND id != ? AND summary IS NOT NULL
           ORDER BY ${NEWEST_CONSOLIDATION}
           LIMIT 1`,
        )
        .get(sessionId, excludeId) as { summary: string } | undefined)
    : (db
        .prepare(
          `SELECT summary FROM consolidations
           WHERE session_id = ? AND summary IS NOT NULL
           ORDER BY ${NEWEST_CONSOLIDATION}
           LIMIT 1`,
        )
        .get(sessionId) as { summary: string } | undefined);
  return row?.summary ?? null;
}

type EventGroup = { ref: ConversationRef; events: SessionEvent[] };

function groupByConversation(events: SessionEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    const ref = conversationRef(event);
    if (!ref) continue;
    const key = `${ref.kind}:${ref.id}`;
    const existing = groups.get(key);
    if (existing) existing.events.push(event);
    else groups.set(key, { ref, events: [event] });
  }
  return [...groups.values()].sort(
    (a, b) => a.events[0].sequence - b.events[0].sequence,
  );
}

function loadSessionWindow(
  db: Db,
  watermark: number,
  ref: ConversationRef,
  limit: number,
  fromSequence?: number,
): SessionEvent[] {
  if (limit <= 0) return [];
  // Kind-branched on purpose: binding the same string to both columns is how
  // two conversations share a window. Client-keyed groups match the client
  // column only; mcp-keyed groups match mcp-only rows (no client id).
  const fromClause =
    fromSequence != null ? " AND sequence >= ?" : "";
  const sql =
    ref.kind === "client"
      ? `SELECT * FROM session_events
         WHERE sequence <= ? AND client_session_id = ?${fromClause}
         ORDER BY sequence DESC
         LIMIT ?`
      : `SELECT * FROM session_events
         WHERE sequence <= ? AND client_session_id IS NULL AND mcp_session_id = ?${fromClause}
         ORDER BY sequence DESC
         LIMIT ?`;
  const params =
    fromSequence != null
      ? [watermark, ref.id, fromSequence, limit]
      : [watermark, ref.id, limit];
  const rows = db.prepare(sql).all(...params) as SessionEventRow[];
  return rows.map(parseEventRow).reverse();
}

function linkExtractedFactToEvents(
  db: Db,
  sessionFactId: string,
  factContent: string,
  groupEvents: SessionEvent[],
): void {
  // Only the FIRST match is primary. `groupEvents` is ordered by sequence, so
  // that is the earliest occurrence — the point the information actually
  // arrived. Later matches are the same text appearing again, which is what
  // `corroborating` means ("mentioned again"), and repeated tool output
  // makes that common: one fact in a real store claimed 145 separate events
  // as the one it came from. Provenance answers "where did this come from",
  // and a question with 145 answers has none.
  //
  // Scoped to this conversation. A mixed pull of two JSONL files used to
  // walk every candidate in the watermark window, so a fact from A could
  // claim B's rows as contextual origin.
  let linkedPrimary = false;
  for (const event of groupEvents) {
    if (event.content && event.content.includes(factContent)) {
      linkFactSource(db, {
        session_fact_id: sessionFactId,
        event_id: event.id,
        relevance: linkedPrimary ? 0.5 : 0.8,
        extraction_type: linkedPrimary ? "corroborating" : "primary",
      });
      linkedPrimary = true;
    }
  }
  if (!linkedPrimary) {
    for (const event of groupEvents) {
      linkFactSource(db, {
        session_fact_id: sessionFactId,
        event_id: event.id,
        relevance: 0.3,
        extraction_type: "contextual",
      });
    }
  }
}

type ExtractPending = {
  group: EventGroup;
  facts: ExtractedFact[];
  situation: ConversationSituation | null;
  closedGist: string | null;
};

function needsReread(outcome: ExtractionOutcome): boolean {
  if (outcome.degraded) return false;
  if (typeof outcome.confidence !== "number") return false;
  return outcome.confidence < EXTRACT_REREAD_CONFIDENCE;
}

function buildSituation(
  prev: ConversationSituation | null,
  outcome: ExtractionOutcome,
  watermark: number,
  firstCandidateSeq: number,
): { situation: ConversationSituation | null; closedGist: string | null } {
  const hasNow = outcome.now !== undefined;
  const hasReferents = outcome.referents !== undefined;
  const shifted = outcome.topic_shifted === true;
  if (!hasNow && !hasReferents && !shifted) {
    return { situation: null, closedGist: null };
  }

  const prevReferents = prev?.referents ?? [];
  const prevSegments = prev?.segments ?? [];
  const prevNow = prev?.now ?? null;
  const prevStart = prev?.now_start_sequence ?? null;
  const referents = hasReferents ? capReferents(outcome.referents) : prevReferents;
  const now = hasNow ? (outcome.now ?? null) : prevNow;

  if (shifted && (prevNow != null || prevReferents.length > 0)) {
    const closed: TopicSegment = {
      start_sequence: prevStart ?? watermark,
      end_sequence: watermark,
      gist: prevNow ?? "",
      referents: prevReferents,
    };
    return {
      situation: {
        now,
        now_start_sequence: firstCandidateSeq,
        referents,
        segments: [...prevSegments, closed],
      },
      closedGist: closed.gist,
    };
  }

  return {
    situation: {
      now,
      now_start_sequence: prevStart ?? firstCandidateSeq,
      referents,
      segments: prevSegments,
    },
    closedGist: null,
  };
}

function situationChanged(
  prev: ConversationSituation | null,
  next: ConversationSituation,
): boolean {
  if (!prev) return true;
  return JSON.stringify(prev) !== JSON.stringify(next);
}

function closedGistsFor(pending: ExtractPending[], sessionId: string): string[] {
  return pending
    .filter((p) => p.group.ref.id === sessionId && p.closedGist)
    .map((p) => p.closedGist as string);
}

function persistSituations(
  db: Db,
  runId: string,
  recordSessionId: string | null,
  pending: ExtractPending[],
  watermark: number,
): Map<string, string> {
  const rows = new Map<string, string>();
  const withState = pending.filter(
    (p): p is ExtractPending & { situation: ConversationSituation } =>
      p.situation != null,
  );
  if (withState.length === 0) return rows;

  if (recordSessionId) {
    const match = withState.find((p) => p.group.ref.id === recordSessionId);
    if (match) {
      applySituation(db, runId, match.situation);
      rows.set(recordSessionId, runId);
    }
    return rows;
  }

  for (const item of withState) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO consolidations
       (id, session_id, facts_in, facts_graduated, facts_rejected,
        entities_created, entities_linked, supersessions,
        summary, open_threads, last_event_sequence, created_at,
        now, now_start_sequence, now_referents, segments)
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      item.group.ref.id,
      watermark,
      new Date().toISOString(),
      item.situation.now,
      item.situation.now_start_sequence,
      JSON.stringify(item.situation.referents),
      JSON.stringify(item.situation.segments),
    );
    rows.set(item.group.ref.id, id);
  }
  return rows;
}

async function extractFactsFromEvents(
  db: Db,
  intelligence: IntelligenceProvider,
  consolidationId: string,
  config?: Partial<ServerConfig>,
): Promise<{ degraded: boolean; pending: ExtractPending[] }> {
  const empty = { degraded: false, pending: [] as ExtractPending[] };
  const workingMemorySize = config?.extraction?.working_memory_size ?? 50;
  const maxContentLength = config?.extraction?.max_content_length ?? 2000;
  const eventTypes = config?.extraction?.event_types ?? null;
  const roles = config?.extraction?.roles ?? null;
  const minContentLength = config?.extraction?.min_content_length ?? 0;
  const evidenceLimit = Math.min(EXTRACT_EVIDENCE_SLICE, workingMemorySize);
  const rereadLimit = Math.min(EXTRACT_REREAD_WINDOW, workingMemorySize);

  const watermarkRow = db
    .prepare(
      `SELECT MAX(last_event_sequence) AS max_seq FROM consolidations`,
    )
    .get() as { max_seq: number | null } | undefined;
  const watermark = watermarkRow?.max_seq ?? 0;

  const candidateRows = db
    .prepare(
      `SELECT * FROM session_events
       WHERE sequence > ?
       ORDER BY sequence ASC`,
    )
    .all(watermark) as SessionEventRow[];

  if (candidateRows.length === 0) return empty;

  const eligible = candidateRows.filter((e) => {
    if (eventTypes && !eventTypes.includes(e.event_type)) return false;
    if (roles && !roles.includes(e.role)) return false;
    return (e.content?.length ?? 0) >= minContentLength;
  });
  if (eligible.length === 0) return empty;

  const newEvents = eligible.map(parseEventRow);
  const groups = groupByConversation(newEvents);
  if (groups.length === 0) return empty;

  // Buffer inserts until every group has been examined. Provider-down
  // (degraded) still discards the whole buffer so a mixed batch cannot
  // advance past an unexamined conversation. Unconfident-after-reread is
  // examined: no I, no now update, other groups still land, watermark moves.
  const pending: ExtractPending[] = [];
  for (const group of groups) {
    const evidence = loadSessionWindow(
      db,
      watermark,
      group.ref,
      evidenceLimit,
    );
    const prior = latestConversationSituation(db, group.ref.id);
    const priorSummary = latestSessionSummary(db, group.ref.id);
    const truncated = group.events.map((e) => ({
      ...e,
      content:
        e.content && e.content.length > maxContentLength
          ? e.content.slice(0, maxContentLength)
          : e.content,
    }));
    const relatedFacts = relatedFactsForExtract(db, truncated);
    const extras = {
      now: prior?.now ?? null,
      referents: prior?.referents ?? [],
      segments: prior?.segments ?? [],
      relatedFacts,
    };

    let outcome = await intelligence.extractFactsFromEvents(
      truncated,
      evidence,
      priorSummary,
      relatedFacts,
      extras,
    );
    if (outcome.degraded) return { degraded: true, pending: [] };

    if (needsReread(outcome)) {
      const reminder = loadSessionWindow(
        db,
        watermark,
        group.ref,
        rereadLimit,
        prior?.now_start_sequence ?? undefined,
      );
      outcome = await intelligence.extractFactsFromEvents(
        truncated,
        evidence,
        priorSummary,
        relatedFacts,
        { ...extras, reminderEvents: reminder },
      );
      if (outcome.degraded) return { degraded: true, pending: [] };
      if (needsReread(outcome)) {
        pending.push({
          group,
          facts: [],
          situation: null,
          closedGist: null,
        });
        continue;
      }
    }

    const firstSeq = group.events[0]?.sequence ?? watermark + 1;
    const built = buildSituation(prior, outcome, watermark, firstSeq);
    pending.push({
      group,
      facts: outcome.facts,
      situation:
        built.situation && situationChanged(prior, built.situation)
          ? built.situation
          : null,
      closedGist: built.closedGist,
    });
  }

  for (const { group, facts } of pending) {
    for (const item of facts) {
      const fact = insertSessionFact(db, {
        session_id: group.ref.id,
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
        linkExtractedFactToEvents(db, fact.id, item.content, group.events);
      }
    }
  }

  return { degraded: false, pending };
}


// ---------------------------------------------------------------------------
// Phase E: embedding
// ---------------------------------------------------------------------------

/**
 * Embed facts that have no vector for the configured model.
 *
 * Works from *the store*, not from what this run happened to graduate. That is
 * what makes it a backfill as well as a write: a run whose provider was down, a
 * store where semantic search was switched on later, and a model change all
 * present identically — facts with no row for the current model — and all drain
 * through this one path with no separate retry bookkeeping.
 *
 * Never throws. Semantic search is an enhancement to retrieval; losing it for a
 * run costs recall until the next consolidation, and the alternative — failing
 * a consolidation that has already committed its facts — costs far more.
 */
async function embedGraduatedFacts(
  db: Db,
  provider: EmbeddingProvider | null,
  config?: Partial<ServerConfig>,
): Promise<void> {
  if (!provider) return;

  const batchSize = config?.embedding?.batch_size ?? 128;

  try {
    // Dimension is only known after the provider's first call on some backends,
    // so probe with a trivial embed rather than assuming a configured value.
    const probe = await provider.embed(["dimension probe"], "document");
    const { model, dimensions } = probe;
    if (!dimensions) return;

    // Drain the queue rather than taking one batch. `batch_size` bounds the
    // size of a request, which is a property of the provider; it must not also
    // decide how much of the backlog a run clears, or turning semantic search
    // on over an existing store would need one consolidation per 128 facts
    // with no indication that more were owed. The backlog is a one-off — a
    // steady-state run embeds the handful of facts that just graduated.
    const attempted = new Set<string>();
    for (;;) {
      const pending = getFactsMissingEmbeddings(db, model, dimensions, batchSize);
      if (pending.length === 0) return;

      // If a batch comes back entirely made of facts already written this run,
      // the writes are not clearing the queue and another pass would repeat
      // itself for ever. Stop rather than spin; the rows still missing are the
      // queue, exactly as after any other failure.
      if (pending.every((f) => attempted.has(f.id))) return;
      for (const f of pending) attempted.add(f.id);

      const result = await provider.embed(
        pending.map((f) => f.content),
        // Stored facts are documents. Embedding them as queries would put them
        // in the wrong half of an asymmetrically-trained model and silently
        // degrade every subsequent search.
        "document",
      );

      if (result.vectors.length !== pending.length) {
        // Misalignment would attach each fact to a different fact's meaning —
        // wrong in a way no downstream check could detect.
        throw new Error(
          `embedding returned ${result.vectors.length} vectors for ${pending.length} facts`,
        );
      }

      // Committed per batch, so a failure part-way through a long backlog keeps
      // everything embedded so far instead of costing the whole run.
      insertEmbeddings(
        db,
        pending.map((f, i) => ({ fact_id: f.id, vector: result.vectors[i] })),
        result.model,
        result.dimensions,
      );

      if (pending.length < batchSize) return;
    }
  } catch {
    // Swallowed on purpose. The missing rows are the retry queue; the next run
    // finds exactly these facts again and tries once more.
  }
}
