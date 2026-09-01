/**
 * Schema creation and versioning.
 * SQLite: PRAGMA user_version, incremental applyVN.
 * Postgres: schema_migrations, current version in one shot.
 */

import { pragmaRead, pragmaWrite } from "./connection.js";
import type { Db } from "./connection.js";
import { applyPostgresSchema, postgresSchemaVersion } from "./postgres-schema.js";
import { seedExtractWatermarksFromConsolidations } from "./extract-watermarks.js";
export { SCHEMA_VERSION } from "./schema-version.js";

/** Read the current schema version from the database. */
export async function getSchemaVersion(db: Db): Promise<number> {
  if (db.dialect === "postgres") return postgresSchemaVersion(db);
  return pragmaRead(db, "user_version");
}

/** Apply any pending schema migrations. */
export async function applySchema(db: Db): Promise<void> {
  if (db.dialect === "postgres") {
    await applyPostgresSchema(db);
    return;
  }
  const version = await getSchemaVersion(db);

  if (version < 1) {
    await applyV1(db);
  }
  if (version < 2) {
    await applyV2(db);
  }
  if (version < 3) {
    await applyV3(db);
  }
  if (version < 4) {
    await applyV4(db);
  }
  if (version < 5) {
    await applyV5(db);
  }
  if (version < 6) {
    await applyV6(db);
  }
  if (version < 7) {
    await applyV7(db);
  }
  if (version < 8) {
    await applyV8(db);
  }
  if (version < 9) {
    await applyV9(db);
  }
  if (version < 10) {
    await applyV10(db);
  }
  if (version < 11) {
    await applyV11(db);
  }
  if (version < 12) {
    await applyV12(db);
  }
  if (version < 13) {
    await applyV13(db);
  }
  if (version < 14) {
    await applyV14(db);
  }
  if (version < 15) {
    await applyV15(db);
  }
  if (version < 16) {
    await applyV16(db);
  }
  if (version < 17) {
    await applyV17(db);
  }
  if (version < 18) {
    await applyV18(db);
  }
  if (version < 19) {
    await applyV19(db);
  }
  if (version < 20) {
    await applyV20(db);
  }
  if (version < 21) {
    await applyV21(db);
  }
  if (version < 22) {
    await applyV22(db);
  }
  if (version < 23) {
    await applyV23(db);
  }
}

// ---------------------------------------------------------------------------
// Schema version 1 — sessions + session_events (DIKW Data layer)
// ---------------------------------------------------------------------------

async function applyV1(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source_tool TEXT,
      project TEXT,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('message', 'tool_call', 'tool_result', 'artifact')),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'json', 'image', 'audio', 'binary')),
      content TEXT,
      content_ref TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session
      ON session_events(session_id, sequence);
  `);

  await pragmaWrite(db, "user_version = 1");
}

// ---------------------------------------------------------------------------
// Schema version 2 — drop FK, split session_id into two nullable columns
// ---------------------------------------------------------------------------

async function applyV2(db: Db): Promise<void> {
  // foreign_keys pragma cannot be changed inside a transaction.
  await pragmaWrite(db, "foreign_keys = OFF");

  await db.exec(`
    CREATE TABLE session_events_new (
      id TEXT PRIMARY KEY,
      mcp_session_id TEXT,
      client_session_id TEXT,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('message', 'tool_call', 'tool_result', 'artifact')),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'json', 'image', 'audio', 'binary')),
      content TEXT,
      content_ref TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO session_events_new
      (id, mcp_session_id, client_session_id, sequence, event_type, role,
       content_type, content, content_ref, metadata, created_at)
    SELECT id, session_id, NULL, sequence, event_type, role,
           content_type, content, content_ref, metadata, created_at
    FROM session_events;

    DROP TABLE session_events;
    ALTER TABLE session_events_new RENAME TO session_events;

    CREATE INDEX idx_session_events_mcp ON session_events(mcp_session_id, sequence);
    CREATE INDEX idx_session_events_client ON session_events(client_session_id);
  `);

  await pragmaWrite(db, "foreign_keys = ON");
  await pragmaWrite(db, "user_version = 2");
}

// ---------------------------------------------------------------------------
// Schema version 3 — session_facts + provenance + domains + consolidation lock
// No FOREIGN KEY constraints on v3/v4 tables. FKs were removed in v2 for
// flexibility with hook-sourced events. Application layer enforces referential
// integrity via findOrCreateEntity, claimForConsolidation, etc.
// ---------------------------------------------------------------------------

async function applyV3(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS session_facts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_origin TEXT NOT NULL DEFAULT 'explicit'
        CHECK (source_origin IN ('explicit', 'inferred')),
      source_event_id TEXT,
      domain_hint TEXT,
      confidence REAL,
      importance REAL,
      source_tool TEXT,
      capture_context TEXT,
      consolidation_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_facts_session
      ON session_facts(session_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_facts_hash
      ON session_facts(session_id, content_hash);

    CREATE INDEX IF NOT EXISTS idx_session_facts_unclaimed
      ON session_facts(created_at) WHERE consolidation_id IS NULL;

    CREATE TABLE IF NOT EXISTS session_fact_sources (
      session_fact_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      relevance REAL NOT NULL DEFAULT 1.0,
      extraction_type TEXT NOT NULL DEFAULT 'contextual'
        CHECK (extraction_type IN ('primary', 'corroborating', 'contextual')),
      PRIMARY KEY (session_fact_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS domains (
      name TEXT PRIMARY KEY,
      subdomains TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consolidation_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      holder TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
  `);

  await pragmaWrite(db, "user_version = 3");
}

// ---------------------------------------------------------------------------
// Schema version 4 — Knowledge layer: facts + FTS5 + entities + graph + sources + consolidations
// ---------------------------------------------------------------------------

async function applyV4(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      domain TEXT NOT NULL,
      subdomain TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      importance REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL,
      source_tool TEXT,
      source_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'superseded', 'rejected')),
      superseded_by TEXT,
      is_latest INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      system_retired_at TEXT,
      session_id TEXT,
      capture_context TEXT,
      access_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      content, domain, subdomain,
      content=facts, content_rowid=rowid
    );

    -- FTS5 external content sync triggers.
    -- Only INSERT and DELETE are needed: facts are immutable so the
    -- FTS5-indexed columns (content, domain, subdomain) are never UPDATEd.
    -- supersedeFact only updates status/is_latest/valid_until (and, in
    -- bi-temporal mode, system_retired_at), which are not in the FTS5 index.
    -- DELETE trigger is a safety net — facts are never deleted in normal
    -- operation, but if one were, FTS5 must stay in sync.
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content, domain, subdomain)
      VALUES (new.rowid, new.content, new.domain, new.subdomain);
    END;

    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, domain, subdomain)
      VALUES ('delete', old.rowid, old.content, old.domain, old.subdomain);
    END;

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS fact_entities (
      fact_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      PRIMARY KEY (fact_id, entity_id, relationship)
    );

    CREATE TABLE IF NOT EXISTS entity_edges (
      from_entity TEXT NOT NULL,
      to_entity TEXT NOT NULL,
      relationship TEXT NOT NULL,
      strength REAL NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT,
      PRIMARY KEY (from_entity, to_entity, relationship)
    );

    -- Source provenance records.
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      tool_id TEXT,
      timestamp TEXT NOT NULL,
      raw_content TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS consolidations (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      facts_in INTEGER NOT NULL,
      facts_graduated INTEGER NOT NULL,
      facts_rejected INTEGER NOT NULL,
      entities_created INTEGER NOT NULL DEFAULT 0,
      entities_linked INTEGER NOT NULL DEFAULT 0,
      supersessions INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      open_threads TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_facts_domain ON facts(domain, subdomain);
    CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status, is_latest);
    CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities(entity_id);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canonical_type ON entities(canonical_name, type);
    CREATE INDEX IF NOT EXISTS idx_entity_edges_from ON entity_edges(from_entity);
    CREATE INDEX IF NOT EXISTS idx_entity_edges_to ON entity_edges(to_entity);
  `);

  await pragmaWrite(db, "user_version = 4");
}

// ---------------------------------------------------------------------------
// Schema version 5 — consolidations.last_event_sequence watermark
// Every consolidation records the highest session_events.sequence observed at
// run start, so threshold checks and extraction catch-up can read a durable
// watermark instead of joining through session_fact_sources (which stalls
// when a run emits zero facts).
// ---------------------------------------------------------------------------

async function applyV5(db: Db): Promise<void> {
  await db.exec(`
    ALTER TABLE consolidations ADD COLUMN last_event_sequence INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_consolidations_created ON consolidations(created_at);
  `);

  await pragmaWrite(db, "user_version = 5");
}

// ---------------------------------------------------------------------------
// Schema version 6 — intelligence provenance + rich staging
// Facts gain a source_quality column so heuristic-era facts can be identified
// and (later) reprocessed when a better provider is available. session_facts
// gain columns for rich extraction output — signals and pre-computed entities
// that the consolidation pipeline carries through to the K-layer without
// re-invoking the LLM. All nullable so the heuristic provider stays conformant.
// ---------------------------------------------------------------------------

async function applyV6(db: Db): Promise<void> {
  await db.exec(`
    ALTER TABLE facts ADD COLUMN source_quality TEXT NOT NULL DEFAULT 'heuristic'
      CHECK (source_quality IN ('heuristic', 'cli', 'sampling', 'explicit'));

    ALTER TABLE session_facts ADD COLUMN subdomain_hint TEXT;
    ALTER TABLE session_facts ADD COLUMN confidence_signal REAL;
    ALTER TABLE session_facts ADD COLUMN importance_signal REAL;
    ALTER TABLE session_facts ADD COLUMN valid_from_hint TEXT;
    ALTER TABLE session_facts ADD COLUMN valid_until_hint TEXT;
    ALTER TABLE session_facts ADD COLUMN entities_json TEXT;
    ALTER TABLE session_facts ADD COLUMN source_quality TEXT NOT NULL DEFAULT 'heuristic'
      CHECK (source_quality IN ('heuristic', 'cli', 'sampling', 'explicit'));
  `);

  await pragmaWrite(db, "user_version = 6");
}

// ---------------------------------------------------------------------------
// Schema version 7 — drop NOT NULL on consolidations.session_id
// Earlier releases created the column as NOT NULL, but the application
// legitimately writes NULL when a consolidation spans multiple sessions or
// when an empty run has no session context. SQLite has no ALTER COLUMN, so
// this is the standard table-rebuild dance.
// ---------------------------------------------------------------------------

async function applyV7(db: Db): Promise<void> {
  await pragmaWrite(db, "foreign_keys = OFF");
  await db.exec(`
    CREATE TABLE consolidations_new (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      facts_in INTEGER NOT NULL,
      facts_graduated INTEGER NOT NULL,
      facts_rejected INTEGER NOT NULL,
      entities_created INTEGER NOT NULL DEFAULT 0,
      entities_linked INTEGER NOT NULL DEFAULT 0,
      supersessions INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      open_threads TEXT,
      created_at TEXT NOT NULL,
      last_event_sequence INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO consolidations_new
      (id, session_id, facts_in, facts_graduated, facts_rejected,
       entities_created, entities_linked, supersessions,
       summary, open_threads, created_at, last_event_sequence)
    SELECT id, session_id, facts_in, facts_graduated, facts_rejected,
           entities_created, entities_linked, supersessions,
           summary, open_threads, created_at, last_event_sequence
    FROM consolidations;

    DROP TABLE consolidations;
    ALTER TABLE consolidations_new RENAME TO consolidations;

    CREATE INDEX IF NOT EXISTS idx_consolidations_created ON consolidations(created_at);
  `);
  await pragmaWrite(db, "foreign_keys = ON");
  await pragmaWrite(db, "user_version = 7");
}

// ---------------------------------------------------------------------------
// Schema version 8 — FTS index over session_facts (unconsolidated knowledge)
// ---------------------------------------------------------------------------

/**
 * Makes captured-but-not-yet-consolidated facts searchable.
 *
 * capture_fact writes to session_facts; only graduated facts reach the `facts`
 * table and its FTS index. Until consolidation ran — by default after 10 events
 * or at session end — a fact the assistant had just been told was unfindable by
 * search_knowledge. "I just told you that" failing is a bad look for a memory
 * engine, and it was silent.
 *
 * Only `content` is indexed. A session fact's domain_hint is a suggestion, not a
 * routing decision, and its entities are unresolved — keyword is the only signal
 * that means anything before consolidation.
 */
async function applyV8(db: Db): Promise<void> {
  await db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_facts_fts USING fts5(
      content,
      content=session_facts, content_rowid=rowid
    );

    -- Sync triggers. INSERT and DELETE only, deliberately:
    -- session_facts.content is never UPDATEd — the sole update in the codebase
    -- sets consolidation_id (claimForConsolidation, and its release on rollback),
    -- which is not indexed here. An UPDATE trigger would fire on every claim and
    -- rewrite the index for a column change FTS5 cannot see.
    -- The DELETE trigger is a safety net: nothing deletes session_facts today,
    -- but retention will, and an external-content index that silently drifts is
    -- worse than one that costs a trigger.
    CREATE TRIGGER IF NOT EXISTS session_facts_ai AFTER INSERT ON session_facts BEGIN
      INSERT INTO session_facts_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS session_facts_ad AFTER DELETE ON session_facts BEGIN
      INSERT INTO session_facts_fts(session_facts_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
  `);

  // Backfill. Triggers only catch rows inserted from now on, so without this
  // every fact captured before this migration stays invisible to search — the
  // exact bug this migration exists to fix, preserved for existing users.
  await db.exec(`
    INSERT INTO session_facts_fts(rowid, content)
    SELECT rowid, content FROM session_facts;
  `);

  await pragmaWrite(db, "user_version = 8");
}

// ---------------------------------------------------------------------------
// Schema version 9 — a designated self entity
//
// Every fact→entity link is currently a mention. There is no way to distinguish
// "this fact is about Robin" from "this fact happens to name Robin", so
// `subject = X` cannot be asked at all — which is why "tell me about my car"
// has no mechanism and identity retrieval has to guess at a domain label
// instead.
//
// Marking subjects needs no schema change: `fact_entities.relationship` is
// freeform text and can carry a reserved value. What does need one is the
// harder half — knowing which entity is the user. "Alex likes coffee" is a fact
// about the user or about a friend depending on who Alex is, and nothing in the
// store has ever recorded that. It is chicken-and-egg, because the user's name
// is learned *from* facts about them.
//
// A nameless singleton breaks it. Identity is a slot, not a value: the row
// exists from `init`, and the name attaches later as an ordinary fact like any
// other. Nothing has to be known about the user for the anchor to be usable.
//
// A column rather than a metadata key or a reserved `type`, because this is an
// invariant the schema can enforce and the other two cannot. A partial unique
// index makes "at most one self" a constraint rather than a convention, and
// `type` is deliberately freeform vocabulary — spending it on a structural flag
// would put a shipped word back into an engine that ships none.
// ---------------------------------------------------------------------------
async function applyV9(db: Db): Promise<void> {
  // SQLite cannot add a column conditionally, and this migration must be safe
  // to run against a store already carrying entities. DEFAULT 0 backfills every
  // existing row as "not the user", which is correct: none of them was.
  await db.exec(`
    ALTER TABLE entities ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0;
  `);

  await db.exec(`
    -- Partial, so it constrains only the single row that claims to be the user
    -- and leaves every other entity unaffected. A second self becomes an error
    -- at the database rather than a duplicate nobody notices.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_self
      ON entities(is_self) WHERE is_self = 1;
  `);

  await pragmaWrite(db, "user_version = 9");
}

// ---------------------------------------------------------------------------
// Schema version 10 — fact embeddings, for semantic retrieval
//
// Search matches words, not meanings: `shellfish` finds the allergy fact,
// `food` does not. FTS5 cannot close that gap — it is lexical by construction.
//
// A separate table rather than columns on `facts`, for two reasons. Facts are
// immutable, and an embedding is not part of the fact — it is a derived view of
// it under one particular model. And re-embedding (a model change, or a
// backfill after a failed run) becomes a delete and insert here, instead of a
// rewrite of a row the whole design says is never rewritten.
//
// No sqlite-vec, no ANN index. The extension is loadable — `node:sqlite`
// supports `allowExtension` — but it is a per-platform native binary, and this
// project deliberately removed its last native dependency when it moved off
// better-sqlite3. At the scale this store operates at, an index also buys
// nothing: a brute-force scan is exact, and the binding constraint is bytes
// read per query rather than arithmetic. 4,000 facts at 512 dimensions is under
// 8 MB — page-cache resident. The scan stops being viable when the working set
// stops fitting there, which is why `dimensions` is configurable: halving it
// doubles the facts that fit in the same budget.
// ---------------------------------------------------------------------------
async function applyV10(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT PRIMARY KEY,
      -- The model and dimension that produced this vector. NOT metadata:
      -- vectors from different models occupy different spaces and comparing
      -- them yields confident nonsense with no error anywhere. Every read
      -- filters on both, so a model change is a detectable state with a
      -- re-embed path rather than silent corruption.
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      -- Float32Array, little-endian. 4 bytes per dimension.
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    -- The scan filters on (model, dimensions) before touching any vector, so
    -- a store mid-migration between models reads only the rows it can use.
    CREATE INDEX IF NOT EXISTS idx_fact_embeddings_model
      ON fact_embeddings(model, dimensions);
  `);

  await pragmaWrite(db, "user_version = 10");
}

// ---------------------------------------------------------------------------
// Schema version 11 — per-file watermarks for client-agnostic capture
//
// Pull tails named transcript files into session_events. A crash mid-file
// must not re-insert lines already written, and a file that was truncated
// or replaced must not be tailed from a now-invalid offset. Consolidation
// already has a watermark (`consolidations.last_event_sequence`); that is
// "how far extraction has read", not "how far a source file has been
// consumed". Stuffing file offsets into consolidations would couple two
// clocks that move independently.
//
// One row per absolute path. `fingerprint` is prefix-hash + suffix-hash +
// size, so a rewrite (compaction) that keeps the same header is still
// detected rather than tailed from a now-invalid offset.
// ---------------------------------------------------------------------------
async function applyV11(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS source_watermarks (
      path TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL,
      line_number INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await pragmaWrite(db, "user_version = 11");
}

// ---------------------------------------------------------------------------
// Schema version 12 — conversation situation for D→I
//
// Per-session extract context lives on consolidations next to the rolling
// summary (same "latest row for this session_id" read). `now` is the activity
// gist; `now_referents` is the last-known deictic board; `segments` are closed
// nows (gist + referents + sequence range). Nullable so existing INSERT
// column lists keep working.
// ---------------------------------------------------------------------------
async function applyV12(db: Db): Promise<void> {
  await db.exec(`
    ALTER TABLE consolidations ADD COLUMN now TEXT;
    ALTER TABLE consolidations ADD COLUMN now_start_sequence INTEGER;
    ALTER TABLE consolidations ADD COLUMN now_referents TEXT;
    ALTER TABLE consolidations ADD COLUMN segments TEXT;
    CREATE INDEX IF NOT EXISTS idx_consolidations_session ON consolidations(session_id);
  `);

  await pragmaWrite(db, "user_version = 12");
}

// ---------------------------------------------------------------------------
// Schema version 13 — FTS index over session_events (D when K is thin)
//
// search_knowledge only looks at graduated facts and pending session_facts.
// A pulled line that extraction has not yet turned into a fact is invisible,
// which is the first-fact miss: the words are in the store and search says
// nothing. Keyword-on-D is the honest fill — not embeddings, not a second
// retrieval product. hybridSearch only reads this index when `results` is
// empty, and returns a short window as `episodes`, kept off `results`.
//
// Only `content` is indexed. Events are append-only: nothing UPDATEs content
// (prune DELETEs). INSERT and DELETE triggers; no UPDATE trigger.
// ---------------------------------------------------------------------------
async function applyV13(db: Db): Promise<void> {
  await db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
      content,
      content=session_events, content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS session_events_ai AFTER INSERT ON session_events
    WHEN new.content IS NOT NULL BEGIN
      INSERT INTO session_events_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS session_events_ad AFTER DELETE ON session_events
    WHEN old.content IS NOT NULL BEGIN
      INSERT INTO session_events_fts(session_events_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
  `);

  await db.exec(`
    INSERT INTO session_events_fts(rowid, content)
    SELECT rowid, content FROM session_events WHERE content IS NOT NULL;
  `);

  await pragmaWrite(db, "user_version = 13");
}

// ---------------------------------------------------------------------------
// Schema version 14 — when a session event was said, vs when it was ingested
//
// `created_at` is when FactMem wrote the row. Claude Code JSONL lines
// already carry a top-level ISO `timestamp` for when the turn was recorded;
// pull used to drop it, so a backfill looked like it all happened at ingest.
// `occurred_at` is when the turn was said: JSONL `timestamp` on pull, or the
// hook/MCP call instant on live capture. A pulled line without a usable
// timestamp stays null rather than copying ingest time.
//
// Not a fact-layer clock. Sequence remains conversation order; this column
// does not reorder extract.
// ---------------------------------------------------------------------------
async function applyV14(db: Db): Promise<void> {
  await db.exec(`
    ALTER TABLE session_events ADD COLUMN occurred_at TEXT;
  `);

  await pragmaWrite(db, "user_version = 14");
}

// ---------------------------------------------------------------------------
// Schema version 15 — gated inferences (hypotheses, not speech)
//
// A hypothesis is not a fact. I→K still only graduates what was said (or
// capture_fact). These rows are the gate: pending until validate_inference
// confirms or rejects. Confirming inserts a facts row with
// source_type = 'inference' and provenance pointing here. Default-off: the
// table exists so a store can opt in without a second migration.
// ---------------------------------------------------------------------------
async function applyV15(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS inferences (
      id TEXT PRIMARY KEY,
      hypothesis TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
      reason TEXT,
      fact_id TEXT,
      created_at TEXT NOT NULL,
      validated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_inferences_status
      ON inferences(status, created_at);

    CREATE TABLE IF NOT EXISTS inference_evidence (
      inference_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      PRIMARY KEY (inference_id, fact_id)
    );
  `);

  await pragmaWrite(db, "user_version = 15");
}

// ---------------------------------------------------------------------------
// Schema version 16 — speaker on I and K
//
// Who uttered the line is source monitoring, not capture path. `source_origin`
// is explicit vs inferred; `source_type` is conversation vs inference. Neither
// is the event's role. Null when we cannot tell (no primary event).
// ---------------------------------------------------------------------------
async function applyV16(db: Db): Promise<void> {
  await db.exec(`
    ALTER TABLE session_facts ADD COLUMN speaker_role TEXT
      CHECK (speaker_role IS NULL OR speaker_role IN ('user', 'assistant', 'system', 'tool'));
    ALTER TABLE facts ADD COLUMN speaker_role TEXT
      CHECK (speaker_role IS NULL OR speaker_role IN ('user', 'assistant', 'system', 'tool'));
  `);
  await pragmaWrite(db, "user_version = 16");
}

// ---------------------------------------------------------------------------
// Schema version 17 — named speaker on D, I, and K
//
// Role is the channel (user/assistant/system/tool). A Teams line is still
// role=user; the person's name lives beside it. Null when the transcript has
// no name. Do not spend a role value on "person".
// ---------------------------------------------------------------------------
async function applyV17(db: Db): Promise<void> {
  await db.exec(`
    ALTER TABLE session_events ADD COLUMN speaker TEXT;
    ALTER TABLE session_facts ADD COLUMN speaker TEXT;
    ALTER TABLE facts ADD COLUMN speaker TEXT;
  `);
  await pragmaWrite(db, "user_version = 17");
}

// ---------------------------------------------------------------------------
// Schema version 18 — backing kinds on session_fact_sources
//
// `corroborating` stays "mentioned again" (same speaker repeating the
// sentence). Assent, tool observation, and restatement by a different
// speaker are extra evidence, not a second fact and not a confidence bump.
// SQLite cannot ALTER a CHECK, so the table is rebuilt.
// ---------------------------------------------------------------------------
async function applyV18(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE session_fact_sources_v18 (
      session_fact_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      relevance REAL NOT NULL DEFAULT 1.0,
      extraction_type TEXT NOT NULL DEFAULT 'contextual'
        CHECK (extraction_type IN (
          'primary', 'corroborating', 'contextual',
          'assent', 'observation', 'restatement'
        )),
      PRIMARY KEY (session_fact_id, event_id)
    );
    INSERT INTO session_fact_sources_v18
      (session_fact_id, event_id, relevance, extraction_type)
      SELECT session_fact_id, event_id, relevance, extraction_type
      FROM session_fact_sources;
    DROP TABLE session_fact_sources;
    ALTER TABLE session_fact_sources_v18 RENAME TO session_fact_sources;
  `);
  await pragmaWrite(db, "user_version = 18");
}

// ---------------------------------------------------------------------------
// Schema version 19 — per-conversation extract watermarks
//
// Consolidation already has last_event_sequence on the run row; that is an
// audit of a global through, not how far each conversation has been read.
// Frequent incremental pull interleaves sequences, so a MAX over run rows would skip a
// neighbour. Same split as source_watermarks (how far a file has been
// consumed) vs extract (how far D→I has read).
// ---------------------------------------------------------------------------
async function applyV19(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS extract_watermarks (
      kind TEXT NOT NULL CHECK (kind IN ('client', 'mcp', 'unkeyed')),
      conversation_id TEXT NOT NULL,
      last_event_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, conversation_id)
    );
  `);
  await seedExtractWatermarksFromConsolidations(db);
  await pragmaWrite(db, "user_version = 19");
}

// ---------------------------------------------------------------------------
// Schema version 20 — intelligence spend meter
//
// One row per billed intelligence run. Not a column on consolidations: capture
// may later bill without a run row, and stats must not have two definitions.
// ---------------------------------------------------------------------------
async function applyV20(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS intelligence_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('consolidate', 'capture')),
      consolidation_id TEXT,
      created_at TEXT NOT NULL,
      usage TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_intelligence_runs_created
      ON intelligence_runs(created_at);
  `);
  await pragmaWrite(db, "user_version = 20");
}

// ---------------------------------------------------------------------------
// Schema version 21 — optional metadata on inferences (entity pair for same_as)
// ---------------------------------------------------------------------------
async function applyV21(db: Db): Promise<void> {
  const cols = (await db.prepare(`PRAGMA table_info(inferences)`).all()) as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "metadata")) {
    await db.exec(`ALTER TABLE inferences ADD COLUMN metadata TEXT;`);
  }
  await pragmaWrite(db, "user_version = 21");
}

// ---------------------------------------------------------------------------
// Schema version 22 — who invoked a billed intelligence run
//
// Nullable on migrate so we do not invent a trigger for rows written before
// this existed. New writes always set trigger.
// ---------------------------------------------------------------------------
async function applyV22(db: Db): Promise<void> {
  const cols = (await db.prepare(`PRAGMA table_info(intelligence_runs)`).all()) as Array<{
    name: string;
  }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("trigger")) {
    await db.exec(`ALTER TABLE intelligence_runs ADD COLUMN trigger TEXT;`);
  }
  if (!names.has("source_tool")) {
    await db.exec(`ALTER TABLE intelligence_runs ADD COLUMN source_tool TEXT;`);
  }
  if (!names.has("project")) {
    await db.exec(`ALTER TABLE intelligence_runs ADD COLUMN project TEXT;`);
  }
  await pragmaWrite(db, "user_version = 22");
}

// ---------------------------------------------------------------------------
// Schema version 23 — HTTP intelligence on source_quality
//
// SQLite cannot ALTER a CHECK. Rebuild facts and session_facts, then recreate
// their FTS indexes from the new rowids.
// ---------------------------------------------------------------------------
async function applyV23(db: Db): Promise<void> {
  const quality =
    "CHECK (source_quality IN ('heuristic', 'cli', 'sampling', 'explicit', 'http'))";
  const tables = (await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()) as Array<{ name: string }>;
  const names = new Set(tables.map((t) => t.name));
  await pragmaWrite(db, "foreign_keys = OFF");
  if (names.has("facts")) {
    await db.exec(`
    DROP TRIGGER IF EXISTS facts_ai;
    DROP TRIGGER IF EXISTS facts_ad;
    DROP TABLE IF EXISTS facts_fts;

    CREATE TABLE facts_v23 (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      domain TEXT NOT NULL,
      subdomain TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      importance REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL,
      source_tool TEXT,
      source_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'superseded', 'rejected')),
      superseded_by TEXT,
      is_latest INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      system_retired_at TEXT,
      session_id TEXT,
      capture_context TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      source_quality TEXT NOT NULL DEFAULT 'heuristic' ${quality},
      speaker_role TEXT
        CHECK (speaker_role IS NULL OR speaker_role IN ('user', 'assistant', 'system', 'tool')),
      speaker TEXT
    );
    INSERT INTO facts_v23 (
      id, content, domain, subdomain, confidence, importance,
      source_type, source_tool, source_id, status, superseded_by, is_latest,
      created_at, valid_from, valid_until, system_retired_at, session_id,
      capture_context, access_count, source_quality, speaker_role, speaker
    )
    SELECT
      id, content, domain, subdomain, confidence, importance,
      source_type, source_tool, source_id, status, superseded_by, is_latest,
      created_at, valid_from, valid_until, system_retired_at, session_id,
      capture_context, access_count, source_quality, speaker_role, speaker
    FROM facts;
    DROP TABLE facts;
    ALTER TABLE facts_v23 RENAME TO facts;
    CREATE INDEX IF NOT EXISTS idx_facts_domain ON facts(domain, subdomain);
    CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status, is_latest);
    CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);

    CREATE VIRTUAL TABLE facts_fts USING fts5(
      content, domain, subdomain,
      content=facts, content_rowid=rowid
    );
    CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content, domain, subdomain)
      VALUES (new.rowid, new.content, new.domain, new.subdomain);
    END;
    CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, domain, subdomain)
      VALUES ('delete', old.rowid, old.content, old.domain, old.subdomain);
    END;
    INSERT INTO facts_fts(rowid, content, domain, subdomain)
    SELECT rowid, content, domain, subdomain FROM facts;
  `);
  }
  if (names.has("session_facts")) {
    await db.exec(`
    DROP TRIGGER IF EXISTS session_facts_ai;
    DROP TRIGGER IF EXISTS session_facts_ad;
    DROP TABLE IF EXISTS session_facts_fts;

    CREATE TABLE session_facts_v23 (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_origin TEXT NOT NULL DEFAULT 'explicit'
        CHECK (source_origin IN ('explicit', 'inferred')),
      source_event_id TEXT,
      domain_hint TEXT,
      subdomain_hint TEXT,
      confidence REAL,
      importance REAL,
      confidence_signal REAL,
      importance_signal REAL,
      valid_from_hint TEXT,
      valid_until_hint TEXT,
      entities_json TEXT,
      source_quality TEXT NOT NULL DEFAULT 'heuristic' ${quality},
      source_tool TEXT,
      capture_context TEXT,
      consolidation_id TEXT,
      created_at TEXT NOT NULL,
      speaker_role TEXT
        CHECK (speaker_role IS NULL OR speaker_role IN ('user', 'assistant', 'system', 'tool')),
      speaker TEXT
    );
    INSERT INTO session_facts_v23 (
      id, session_id, content, content_hash, source_origin, source_event_id,
      domain_hint, subdomain_hint, confidence, importance, confidence_signal,
      importance_signal, valid_from_hint, valid_until_hint, entities_json,
      source_quality, source_tool, capture_context, consolidation_id, created_at,
      speaker_role, speaker
    )
    SELECT
      id, session_id, content, content_hash, source_origin, source_event_id,
      domain_hint, subdomain_hint, confidence, importance, confidence_signal,
      importance_signal, valid_from_hint, valid_until_hint, entities_json,
      source_quality, source_tool, capture_context, consolidation_id, created_at,
      speaker_role, speaker
    FROM session_facts;
    DROP TABLE session_facts;
    ALTER TABLE session_facts_v23 RENAME TO session_facts;
    CREATE INDEX IF NOT EXISTS idx_session_facts_session ON session_facts(session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_facts_hash
      ON session_facts(session_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_session_facts_unclaimed
      ON session_facts(created_at) WHERE consolidation_id IS NULL;

    CREATE VIRTUAL TABLE session_facts_fts USING fts5(
      content,
      content=session_facts, content_rowid=rowid
    );
    CREATE TRIGGER session_facts_ai AFTER INSERT ON session_facts BEGIN
      INSERT INTO session_facts_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER session_facts_ad AFTER DELETE ON session_facts BEGIN
      INSERT INTO session_facts_fts(session_facts_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
    INSERT INTO session_facts_fts(rowid, content)
    SELECT rowid, content FROM session_facts;
  `);
  }
  await pragmaWrite(db, "foreign_keys = ON");
  await pragmaWrite(db, "user_version = 23");
}
