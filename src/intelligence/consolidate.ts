/**
 * Consolidation pipeline — the core intelligence engine.
 * Two DIKW arrows, independently timed:
 *   D → I: Extract facts from raw events (tick / pull / Stop)
 *   I → K: Graduate session_facts through classify, entities, reconcile,
 *          supersede (flush / PreCompact / shutdown)
 *   Both:  MCP `consolidate` tool, CLI, session-start leftovers (`full`)
 *
 * Loose analogy to human memory: rapid, context-rich capture during a session
 * is separated from a later batch that integrates new information with prior
 * knowledge. Not a model of hippocampal-cortical dynamics, and not a dream
 * that invents facts nobody said.
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
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_IMPORTANCE,
  DEFAULT_CONFIG,
  type ServerConfig,
} from "../types/config.js";
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
import { attachBackingSources } from "./backing.js";
import {
  claimForConsolidation,
  getClaimedFacts,
  insertSessionFact,
  linkFactSource,
  primaryEventForFact,
  speakerRoleOf,
  speakerNameOf,
  UTTERED_BY,
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
  findEntity,
  getEntityById,
  linkFactEntity,
  upsertEntityEdge,
  ensureSelfEntity,
  SUBJECT_OF,
  listEntityTypes,
} from "../db/entities.js";
import { isAboutTheUser } from "./subject.js";
import { ensureDomain, loadStoreVocabulary } from "../db/domains.js";
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

/**
 * Which arrows of consolidate() to run.
 *
 * `full` is the tester path and the MCP tool. `extract` is D→I on pull/Stop
 * (tick). `graduate` is I→K on PreCompact flush / shutdown — skip extract so
 * compaction is not four `claude -p` stages when D was already examined.
 */
export type ConsolidatePhase = "extract" | "graduate" | "full";

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
   * A configured extract call failed, so some events were not examined.
   * A prefix of earlier events may still have been kept; examinedThrough is
   * how far the watermark moved (held, a prefix, or complete).
   *
   * Reported because the failure is otherwise invisible: facts captured
   * explicitly still graduate, so the run returns healthy-looking counts while
   * unread conversation looks like a successful empty extract.
   */
  extractionDegraded?: boolean;
  /** Watermark this run wrote, or the previous value if held. */
  examinedThrough: number;
  /** True when a later extract call failed but an honest prefix was kept. */
  prefixCommitted?: boolean;
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
  phase: ConsolidatePhase = "full",
): Promise<ConsolidationResult> {
  const consolidationId = randomUUID();
  const doExtract = phase === "extract" || phase === "full";
  const doGraduate = phase === "graduate" || phase === "full";
  const extractionEnabled = config?.extraction?.enabled ?? false;
  // Read from the vocabulary the user configured, not a separate map. Importance
  // is a property of a domain — a domain's calibration belongs with the domain,
  // and a second list keyed by name is one more thing to drift. Whoever owns the
  // vocabulary owns its calibration: a missed allergy is the costliest error in a
  // personal store, a missed SLA breach in a corporate one, and the engine cannot
  // know which it is looking at.
  const storeVocabulary = await loadStoreVocabulary(db, config?.domains ?? []);
  const defaultsByDomain = importanceDefaults(storeVocabulary);

  // Phase A: Acquire lock
  const locked = await acquireLock(db, consolidationId);
  if (!locked) {
    const held = (await db
      .prepare(
        `SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`,
      )
      .get()) as { seq: number };
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
      examinedThrough: held.seq,
    };
  }

  // Capture the event watermark at run start — the highest session_events.sequence
  // observed. Stored on the consolidations row at commit time so the scheduler's
  // threshold check and extractFactsFromEvents both read a durable watermark,
  // regardless of whether any facts emerged from this run.
  const watermarkRow = (await db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) AS seq FROM session_events`)
    .get()) as { seq: number };
  const runWatermark = watermarkRow.seq;

  // Previous watermark, used to decide whether an empty run is worth recording.
  // An empty run that doesn't advance the watermark is pure noise — subsequent
  // reads already see the same max(last_event_sequence) without our row.
  const prevWatermarkRow = (await db
    .prepare(`SELECT COALESCE(MAX(last_event_sequence), 0) AS seq FROM consolidations`)
    .get()) as { seq: number };
  const prevWatermark = prevWatermarkRow.seq;

  // Set when the configured extractor could not run. The events it was meant to
  // read have not been examined, so the watermark must stay where it was and
  // leave them eligible for the next run. Advancing regardless is what made a
  // transient provider failure discard a batch of conversation for good.
  let extractionDegraded = false;
  let extractPending: ExtractPending[] = [];
  let extractProgress: ExtractProgress | null = null;

  let phaseDCommitted = false;
  try {
    // Phase B: D→I event extraction (if this run examines events).
    // Session facts land unclaimed so a later graduate-only flush can pick
    // them up — extract on tick, graduate on PreCompact, not four LLM stages
    // in the compaction hook.
    if (doExtract && extractionEnabled) {
      const extracted = await extractFactsFromEvents(
        db,
        intelligence,
        config,
      );
      extractionDegraded = extracted.degraded;
      extractPending = extracted.pending;
      extractProgress = extracted.progress;
    }

    // Graduate-only holds; policy-off or a finished extract advances to
    // run-start max; an honest prefix stops at `through`; provider-down
    // with no prefix holds. Do not treat policy-off as degraded.
    const effectiveWatermark = !doExtract
      ? prevWatermark
      : !extractionEnabled || extractProgress?.kind === "complete"
        ? runWatermark
      : extractProgress?.kind === "prefix"
        ? extractProgress.through
      : prevWatermark;
    const prefixCommitted = extractProgress?.kind === "prefix";

    if (doGraduate) {
      await claimForConsolidation(db, consolidationId);
    }
    const sessionFacts = doGraduate
      ? await getClaimedFacts(db, consolidationId)
      : [];

    if (sessionFacts.length === 0) {
      // Only record an empty run when this run examined events and the
      // watermark actually advances. Graduate-only with nothing pending is
      // a PreCompact no-op — do not spam rows or pretend D was read.
      if (doExtract && effectiveWatermark > prevWatermark) {
        const onlyId =
          extractPending.length === 1 ? extractPending[0].group.ref.id : null;
        await db.prepare(
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
        await persistSituations(
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
      if (doGraduate) {
        await embedGraduatedFacts(db, embeddingProvider, config);
      }

      await releaseLock(db, consolidationId);
      const extractedCount = extractPending.reduce(
        (n, p) => n + p.facts.length,
        0,
      );
      return {
        consolidationId,
        extractionDegraded,
        factsIn: extractedCount,
        factsGraduated: 0,
        factsRejected: 0,
        entitiesCreated: 0,
        entitiesLinked: 0,
        supersessions: 0,
        summary: null,
        openThreads: [],
        skipped: false,
        examinedThrough: effectiveWatermark,
        prefixCommitted,
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
    const getDomainFacts = async (domain: string): Promise<Fact[]> => {
      let cached = domainCache.get(domain);
      if (!cached) {
        cached = await getFactsByDomain(db, domain);
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

      const domainFacts = await getDomainFacts(cf.domain);
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
      const candidates = await getDomainFacts(item.domain);
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
    const writeResults = await withTransaction(db, async () => {
      let entitiesCreated = 0;
      let entitiesLinked = 0;

      // Ensure all unique domains exist once, before the per-fact loop
      const uniqueDomains = new Set(toGraduate.map((item) => item.domain));
      for (const domain of uniqueDomains) {
        await ensureDomain(db, domain);
      }

      for (const item of toGraduate) {
        const sessionFact = sessionFactMap.get(item.sessionFactId)!;

        // Write provenance source linking graduated fact back to its session_fact
        // (and through session_fact_sources, to the originating events).
        const source = await createSource(db, {
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

        // World time if extract stated a real ISO day; explicit null if not.
        // Do not omit the field — insertFact would then default to now, and a
        // past event would look as if it became true at graduation.
        const validFrom = sessionFact.valid_from_hint;

        const graduatedFact = supersededId
          ? await supersedeFact(db, supersededId, {
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
              speaker_role: sessionFact.speaker_role,
              speaker: sessionFact.speaker,
              valid_from: validFrom,
            }, {
              // Fourth clock is config-gated: simple mode (the default) never
              // writes system_retired_at. Bi-temporal mode stamps the instant
              // the system retracted belief in the old fact.
              retireSystemTime: config?.temporal?.mode === "bitemporal",
            })
          : await insertFact(db, {
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
              speaker_role: sessionFact.speaker_role,
              speaker: sessionFact.speaker,
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
              const existing = await getEntityById(db, entity.existing_id);
              if (existing) resolvedId = existing.id;
            }

            if (!resolvedId) {
              const { entity: resolved, created } = await findOrCreateEntity(db, {
                type: entity.type,
                name: entity.name,
              });
              if (created) entitiesCreated++;
              resolvedId = resolved.id;
            }

            resolvedIds.push(resolvedId);
            await linkFactEntity(db, factId, resolvedId, entity.relationship);
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
              await upsertEntityEdge(db, a, b, "co_mentioned");
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
        // Only the deterministic self-case is handled here. Third-party
        // subjects come from the provider's entity list (subject_of). A wrong
        // automatic guess is worse than a mention-only link.
        if (isAboutTheUser(graduatedFact.content)) {
          await linkFactEntity(db, graduatedFact.id, (await ensureSelfEntity(db)).id, SUBJECT_OF);
          entitiesLinked++;
        }

        // Named speaker is source, not subject. Link only when the person
        // already exists — do not mint an entity from a Teams display name.
        if (sessionFact.speaker) {
          const named = await findEntity(db, sessionFact.speaker);
          if (named) {
            await linkFactEntity(db, graduatedFact.id, named.id, UTTERED_BY);
            entitiesLinked++;
          }
        } else if (sessionFact.speaker_role === "user") {
          // Unnamed user-channel speech is said by the store's owner.
          // Do not write speaker "self" or "the user" — the link is the id.
          await linkFactEntity(
            db,
            graduatedFact.id,
            (await ensureSelfEntity(db)).id,
            UTTERED_BY,
          );
          entitiesLinked++;
        }
      }

      // Apply enrich decisions — boost existing facts' confidence (capped at 1.0)
      // for each paraphrase/corroboration the LLM identified.
      const enrichStmt = db.prepare(
        `UPDATE facts SET confidence = MIN(1.0, confidence + ?) WHERE id = ?`,
      );
      for (const e of enrichments) {
        await enrichStmt.run(e.confidenceDelta, e.existingFactId);
      }

      // Insert consolidation record
      await db.prepare(
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
    await releaseLock(db, consolidationId);

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
      const priorSessionSummary = await latestSessionSummary(
        db,
        recordSessionId,
        consolidationId,
      );
      try {
        await persistSituations(
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
        await db.prepare(
          `UPDATE consolidations SET summary = ?, open_threads = ? WHERE id = ?`,
        ).run(summaryText, JSON.stringify(threads), consolidationId);
      } catch {
        if (conflictMessages.length > 0) {
          await db.prepare(
            `UPDATE consolidations SET open_threads = ? WHERE id = ?`,
          ).run(JSON.stringify(conflictMessages), consolidationId);
        }
      }
    } else {
      if (conflictMessages.length > 0) {
        await db.prepare(
          `UPDATE consolidations SET open_threads = ? WHERE id = ?`,
        ).run(JSON.stringify(conflictMessages), consolidationId);
      }
      const situationRows = await persistSituations(
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
        const prior = await latestSessionSummary(db, sessionId, consolidationId);
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
            await db.prepare(
              `UPDATE consolidations SET summary = ?, open_threads = ? WHERE id = ?`,
            ).run(
              summaryResult.summary,
              JSON.stringify(summaryResult.openThreads),
              existingId,
            );
          } else {
            await db.prepare(
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
      examinedThrough: effectiveWatermark,
      prefixCommitted,
    };
  } catch (err) {
    // Only unclaim if Phase D hasn't committed — otherwise the facts are
    // already graduated and unclaiming would cause re-processing on the next run.
    if (!phaseDCommitted) {
      await db.prepare(
        `UPDATE session_facts SET consolidation_id = NULL WHERE consolidation_id = ?`,
      ).run(consolidationId);
    }
    // Release lock on error if not already released
    await releaseLock(db, consolidationId);
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

async function latestSessionSummary(
  db: Db,
  sessionId: string,
  excludeId?: string,
): Promise<string | null> {
  const row = excludeId
    ? ((await db
        .prepare(
          `SELECT summary FROM consolidations
           WHERE session_id = ? AND id != ? AND summary IS NOT NULL
           ORDER BY ${NEWEST_CONSOLIDATION}
           LIMIT 1`,
        )
        .get(sessionId, excludeId)) as { summary: string } | undefined)
    : ((await db
        .prepare(
          `SELECT summary FROM consolidations
           WHERE session_id = ? AND summary IS NOT NULL
           ORDER BY ${NEWEST_CONSOLIDATION}
           LIMIT 1`,
        )
        .get(sessionId)) as { summary: string } | undefined);
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

async function loadSessionWindow(
  db: Db,
  watermark: number,
  ref: ConversationRef,
  limit: number,
  fromSequence?: number,
): Promise<SessionEvent[]> {
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
  const rows = (await db.prepare(sql).all(...params)) as SessionEventRow[];
  return rows.map(parseEventRow).reverse();
}

/** All events in a conversation, including lines too short to extract. */
async function loadConversationEvents(
  db: Db,
  ref: ConversationRef,
): Promise<SessionEvent[]> {
  const sql =
    ref.kind === "client"
      ? `SELECT * FROM session_events WHERE client_session_id = ? ORDER BY sequence ASC`
      : `SELECT * FROM session_events
         WHERE client_session_id IS NULL AND mcp_session_id = ?
         ORDER BY sequence ASC`;
  const rows = (await db.prepare(sql).all(ref.id)) as SessionEventRow[];
  return rows.map(parseEventRow);
}

async function linkExtractedFactToEvents(
  db: Db,
  sessionFactId: string,
  factContent: string,
  groupEvents: SessionEvent[],
): Promise<void> {
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
  let primary: SessionEvent | null = null;
  for (const event of groupEvents) {
    if (event.content && event.content.includes(factContent)) {
      if (!linkedPrimary) {
        await linkFactSource(db, {
          session_fact_id: sessionFactId,
          event_id: event.id,
          relevance: 0.8,
          extraction_type: "primary",
        });
        linkedPrimary = true;
        primary = event;
      }
    }
  }
  if (!linkedPrimary) {
    // Rewritten extracts are not a substring of any event. Linking every
    // event in the conversation as contextual makes provenance unanswerable
    // (hundreds of 0.3 rows, one primary). Leave the fact unlinked rather
    // than claiming the whole episode as origin.
    return;
  }

  await attachBackingSources(db, sessionFactId, factContent, groupEvents);

  // Same speaker repeating the sentence is fluency, not backing.
  for (const event of groupEvents) {
    if (!primary || event.id === primary.id) continue;
    if (!event.content || !event.content.includes(factContent)) continue;
    if (event.speaker !== primary.speaker || event.role !== primary.role) continue;
    await linkFactSource(db, {
      session_fact_id: sessionFactId,
      event_id: event.id,
      relevance: 0.5,
      extraction_type: "corroborating",
    });
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

async function persistSituations(
  db: Db,
  runId: string,
  recordSessionId: string | null,
  pending: ExtractPending[],
  watermark: number,
): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  const withState = pending.filter(
    (p): p is ExtractPending & { situation: ConversationSituation } =>
      p.situation != null,
  );
  if (withState.length === 0) return rows;

  if (recordSessionId) {
    const match = withState.find((p) => p.group.ref.id === recordSessionId);
    if (match) {
      await applySituation(db, runId, match.situation);
      rows.set(recordSessionId, runId);
    }
    return rows;
  }

  for (const item of withState) {
    const id = randomUUID();
    await db.prepare(
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

type ExtractProgress =
  | { kind: "complete" }
  | { kind: "prefix"; through: number }
  | { kind: "none" };

type ExtractResult = {
  degraded: boolean;
  pending: ExtractPending[];
  progress: ExtractProgress;
};

function truncateForPrompt(
  events: SessionEvent[],
  maxContentLength: number,
): SessionEvent[] {
  return events.map((e) => ({
    ...e,
    content:
      e.content && e.content.length > maxContentLength
        ? e.content.slice(0, maxContentLength)
        : e.content,
  }));
}

function chunkEvents(events: SessionEvent[], batchSize: number): SessionEvent[][] {
  const size = Math.max(1, batchSize);
  const chunks: SessionEvent[][] = [];
  for (let i = 0; i < events.length; i += size) {
    chunks.push(events.slice(i, i + size));
  }
  return chunks;
}

function lastSeq(events: SessionEvent[]): number | null {
  if (events.length === 0) return null;
  return Math.max(...events.map((e) => e.sequence));
}

function prefixIsHonest(examined: SessionEvent[], remaining: SessionEvent[]): boolean {
  if (examined.length === 0) return false;
  // Math.min(...[]) is Infinity, which would make any non-empty examined look honest.
  // Empty remaining on a degrade path is a programming error, not a prefix — fail closed.
  if (remaining.length === 0) return false;
  const maxExamined = Math.max(...examined.map((e) => e.sequence));
  const minRemaining = Math.min(...remaining.map((e) => e.sequence));
  return maxExamined < minRemaining;
}

function mergeChunk(pending: ExtractPending[], chunk: ExtractPending): void {
  const last = pending[pending.length - 1];
  const same =
    last &&
    last.group.ref.kind === chunk.group.ref.kind &&
    last.group.ref.id === chunk.group.ref.id;
  if (!same) {
    pending.push(chunk);
    return;
  }
  last.group.events.push(...chunk.group.events);
  last.facts.push(...chunk.facts);
  if (chunk.situation) last.situation = chunk.situation;
  if (chunk.closedGist) last.closedGist = chunk.closedGist;
}

async function persistPending(db: Db, pending: ExtractPending[]): Promise<void> {
  for (const { group, facts } of pending) {
    for (const item of facts) {
      const primary = primaryEventForFact(group.events, item.content);
      const fact = await insertSessionFact(db, {
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
        speaker_role: speakerRoleOf(primary?.role),
        speaker: speakerNameOf(primary?.speaker),
        // Unclaimed: a later graduate-only flush (PreCompact) picks these up.
        consolidation_id: null,
      });

      if (fact) {
        // Assent lines are shorter than min_content_length, so they are not
        // extract candidates. Backing still needs the whole conversation.
        const window = await loadConversationEvents(db, group.ref);
        await linkExtractedFactToEvents(
          db,
          fact.id,
          item.content,
          window.length > 0 ? window : group.events,
        );
      }
    }
  }
}

function settleDegraded(
  pending: ExtractPending[],
  failedChunk: SessionEvent[],
  laterChunks: SessionEvent[][],
  laterGroups: EventGroup[],
): { pending: ExtractPending[]; progress: ExtractProgress } {
  const examined = pending.flatMap((p) => p.group.events);
  const remaining = [
    ...failedChunk,
    ...laterChunks.flat(),
    ...laterGroups.flatMap((g) => g.events),
  ];
  if (prefixIsHonest(examined, remaining)) {
    return {
      pending,
      progress: { kind: "prefix", through: Math.max(...examined.map((e) => e.sequence)) },
    };
  }
  return { pending: [], progress: { kind: "none" } };
}

async function finishDegraded(
  db: Db,
  pending: ExtractPending[],
  failedChunk: SessionEvent[],
  laterChunks: SessionEvent[][],
  laterGroups: EventGroup[],
): Promise<ExtractResult> {
  const settled = settleDegraded(pending, failedChunk, laterChunks, laterGroups);
  await persistPending(db, settled.pending);
  return { degraded: true, pending: settled.pending, progress: settled.progress };
}

async function extractFactsFromEvents(
  db: Db,
  intelligence: IntelligenceProvider,
  config?: Partial<ServerConfig>,
): Promise<ExtractResult> {
  const empty: ExtractResult = {
    degraded: false,
    pending: [],
    progress: { kind: "complete" },
  };
  const workingMemorySize =
    config?.extraction?.working_memory_size ??
    DEFAULT_CONFIG.extraction.working_memory_size;
  const maxContentLength =
    config?.extraction?.max_content_length ??
    DEFAULT_CONFIG.extraction.max_content_length;
  const batchSize = Math.max(
    1,
    config?.extraction?.batch_size ?? DEFAULT_CONFIG.extraction.batch_size,
  );
  const eventTypes = config?.extraction?.event_types ?? null;
  const roles = config?.extraction?.roles ?? null;
  const minContentLength = config?.extraction?.min_content_length ?? 0;
  const evidenceLimit = Math.min(EXTRACT_EVIDENCE_SLICE, workingMemorySize);
  const rereadLimit = Math.min(EXTRACT_REREAD_WINDOW, workingMemorySize);

  const watermarkRow = (await db
    .prepare(
      `SELECT MAX(last_event_sequence) AS max_seq FROM consolidations`,
    )
    .get()) as { max_seq: number | null } | undefined;
  const watermark = watermarkRow?.max_seq ?? 0;

  const candidateRows = (await db
    .prepare(
      `SELECT * FROM session_events
       WHERE sequence > ?
       ORDER BY sequence ASC`,
    )
    .all(watermark)) as SessionEventRow[];

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

  const vocabulary = await loadStoreVocabulary(db, config?.domains ?? []);
  const entityTypes = await listEntityTypes(db);

  const pending: ExtractPending[] = [];
  const remainingGroups = [...groups];

  for (const group of groups) {
    remainingGroups.shift();
    const truncated = truncateForPrompt(group.events, maxContentLength);
    const chunks = chunkEvents(truncated, batchSize);
    let prior = await latestConversationSituation(db, group.ref.id);
    const priorSummary = await latestSessionSummary(db, group.ref.id);
    const dbEvidence = truncateForPrompt(
      await loadSessionWindow(db, watermark, group.ref, evidenceLimit),
      maxContentLength,
    );
    const earlierThisRun: SessionEvent[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const evidence =
        earlierThisRun.length > 0
          ? truncateForPrompt(
              [...dbEvidence, ...earlierThisRun].slice(-evidenceLimit),
              maxContentLength,
            )
          : dbEvidence;
      const relatedFacts = await relatedFactsForExtract(db, chunk);
      const extras = {
        now: prior?.now ?? null,
        referents: prior?.referents ?? [],
        segments: prior?.segments ?? [],
        relatedFacts,
        vocabulary,
        entityTypes,
      };

      let outcome = await intelligence.extractFactsFromEvents(
        chunk,
        evidence,
        priorSummary,
        relatedFacts,
        extras,
      );
      if (outcome.degraded) {
        return finishDegraded(
          db,
          pending,
          chunk,
          chunks.slice(i + 1),
          remainingGroups,
        );
      }
      if (needsReread(outcome)) {
        const reminder = truncateForPrompt(
          await loadSessionWindow(
            db,
            watermark,
            group.ref,
            rereadLimit,
            prior?.now_start_sequence ?? undefined,
          ),
          maxContentLength,
        );
        outcome = await intelligence.extractFactsFromEvents(
          chunk,
          evidence,
          priorSummary,
          relatedFacts,
          {
            ...extras,
            reminderEvents: truncateForPrompt(
              reminder.concat(earlierThisRun).slice(-rereadLimit),
              maxContentLength,
            ),
          },
        );
        if (outcome.degraded) {
          return finishDegraded(
            db,
            pending,
            chunk,
            chunks.slice(i + 1),
            remainingGroups,
          );
        }
        if (needsReread(outcome)) {
          mergeChunk(pending, {
            group: { ref: group.ref, events: [...chunk] },
            facts: [],
            situation: null,
            closedGist: null,
          });
          earlierThisRun.push(...chunk);
          continue;
        }
      }

      const firstSeq = chunk[0]?.sequence ?? watermark + 1;
      const built = buildSituation(
        prior,
        outcome,
        lastSeq(earlierThisRun) ?? watermark,
        firstSeq,
      );
      const situation =
        built.situation && situationChanged(prior, built.situation)
          ? built.situation
          : null;
      if (built.situation) prior = built.situation;
      mergeChunk(pending, {
        group: { ref: group.ref, events: [...chunk] },
        facts: outcome.facts,
        situation,
        closedGist: built.closedGist,
      });
      earlierThisRun.push(...chunk);
    }
  }

  await persistPending(db, pending);
  return { degraded: false, pending, progress: { kind: "complete" } };
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
      const pending = await getFactsMissingEmbeddings(db, model, dimensions, batchSize);
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
      await insertEmbeddings(
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
