/**
 * Schema creation and versioning.
 * Uses PRAGMA user_version for migration tracking.
 */

import type Database from "better-sqlite3";

/** Read the current schema version from the database. */
export function getSchemaVersion(db: Database.Database): number {
  const row = db.pragma("user_version", { simple: true });
  return typeof row === "number" ? row : 0;
}

/** Apply any pending schema migrations. */
export function applySchema(db: Database.Database): void {
  const version = getSchemaVersion(db);

  if (version < 1) {
    applyV1(db);
  }
  if (version < 2) {
    applyV2(db);
  }
  if (version < 3) {
    applyV3(db);
  }
  if (version < 4) {
    applyV4(db);
  }
}

// ---------------------------------------------------------------------------
// Schema version 1 — sessions + session_events (DIKW Data layer)
// ---------------------------------------------------------------------------

function applyV1(db: Database.Database): void {
  db.exec(`
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

  db.pragma("user_version = 1");
}

// ---------------------------------------------------------------------------
// Schema version 2 — drop FK, split session_id into two nullable columns
// ---------------------------------------------------------------------------

function applyV2(db: Database.Database): void {
  // foreign_keys pragma cannot be changed inside a transaction.
  db.pragma("foreign_keys = OFF");

  db.exec(`
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

  db.pragma("foreign_keys = ON");
  db.pragma("user_version = 2");
}

// ---------------------------------------------------------------------------
// Schema version 3 — session_facts + provenance + domains + consolidation lock
// No FOREIGN KEY constraints on v3/v4 tables. FKs were removed in v2 for
// flexibility with hook-sourced events. Application layer enforces referential
// integrity via findOrCreateEntity, claimForConsolidation, etc.
// ---------------------------------------------------------------------------

function applyV3(db: Database.Database): void {
  db.exec(`
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

  db.pragma("user_version = 3");
}

// ---------------------------------------------------------------------------
// Schema version 4 — Knowledge layer: facts + FTS5 + entities + graph + sources + consolidations
// ---------------------------------------------------------------------------

function applyV4(db: Database.Database): void {
  db.exec(`
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
    -- supersedeFact only updates status/is_latest/valid_until, which are not
    -- in the FTS5 index. DELETE trigger is a safety net — facts are never
    -- deleted in normal operation, but if one were, FTS5 must stay in sync.
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

    -- Phase 2: source provenance records. No data access module yet.
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

  db.pragma("user_version = 4");
}
