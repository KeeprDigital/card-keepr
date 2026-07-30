PRAGMA foreign_keys = ON;

CREATE TABLE source_adapter_versions (
  adapter_version TEXT PRIMARY KEY,
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  parser_contract TEXT NOT NULL,
  UNIQUE (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

-- This seed is a database constraint copy of sourceAdapterRegistrations in
-- src/catalogue/source-adapters.ts. The Worker drift test requires exact
-- agreement because SQLite migrations cannot import runtime TypeScript.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract
) VALUES
  (
    'one-piece-json-document@1',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'one-piece-card-document@1'
  ),
  (
    'one-piece-en@1',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'one-piece-card-document@1'
  );

CREATE TABLE ingestion_evidence_plans (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  request_plan_json TEXT NOT NULL,
  parent_workflow_id TEXT,
  child_workflow_ids_json TEXT,
  collection_completed_at TEXT,
  failure_code TEXT,
  FOREIGN KEY (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  ) REFERENCES source_adapter_versions (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

CREATE TABLE source_requests (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  request_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method = 'GET'),
  url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  representation_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'captured', 'observed', 'failed')
  ),
  source_snapshot_id TEXT,
  failure_code TEXT,
  PRIMARY KEY (ingestion_run_id, request_id),
  UNIQUE (ingestion_run_id, sequence_number)
);

CREATE TABLE source_fetch_attempts (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'success',
      'cache_revalidated',
      'redirect',
      'http_failure',
      'network_failure',
      'body_failure',
      'storage_failure',
      'content_rejected'
    )
  ),
  http_status INTEGER,
  response_headers_json TEXT NOT NULL,
  retry_after_ms INTEGER,
  diagnostic TEXT,
  FOREIGN KEY (ingestion_run_id, request_id)
    REFERENCES source_requests(ingestion_run_id, request_id),
  UNIQUE (ingestion_run_id, request_id, attempt_number)
);

CREATE TABLE source_capture_operations (
  attempt_id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  source_snapshot_id TEXT NOT NULL UNIQUE,
  content_object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN (
      'planned',
      'response_received',
      'uploaded',
      'finalized',
      'failed'
    )
  ),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  request_headers_json TEXT,
  http_status INTEGER,
  response_headers_json TEXT,
  response_vary_json TEXT,
  media_type TEXT,
  content_digest TEXT,
  content_byte_length INTEGER,
  reused_source_snapshot_id TEXT REFERENCES source_snapshots(id),
  failure_outcome TEXT CHECK (
    failure_outcome IN (
      'network_failure',
      'body_failure',
      'storage_failure'
    )
  ),
  diagnostic TEXT,
  FOREIGN KEY (ingestion_run_id, request_id)
    REFERENCES source_requests(ingestion_run_id, request_id),
  UNIQUE (ingestion_run_id, request_id, attempt_number)
);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  request_id TEXT NOT NULL,
  fetch_attempt_id TEXT NOT NULL UNIQUE REFERENCES source_fetch_attempts(id),
  request_method TEXT NOT NULL,
  request_url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  representation_fingerprint TEXT NOT NULL,
  response_vary_json TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  response_headers_json TEXT NOT NULL,
  media_type TEXT,
  content_digest TEXT NOT NULL,
  content_byte_length INTEGER NOT NULL,
  content_object_key TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  reused_source_snapshot_id TEXT REFERENCES source_snapshots(id),
  FOREIGN KEY (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  ) REFERENCES source_adapter_versions (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

CREATE INDEX source_snapshots_revalidation
ON source_snapshots (
  source_lineage,
  request_url,
  adapter_version,
  representation_fingerprint,
  retrieved_at DESC
);

CREATE TABLE source_parse_operations (
  id TEXT PRIMARY KEY,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  adapter_version TEXT NOT NULL REFERENCES source_adapter_versions(adapter_version),
  intent TEXT NOT NULL CHECK (intent IN ('collection', 'reparse')),
  idempotency_key TEXT NOT NULL,
  observation_set_id TEXT NOT NULL UNIQUE,
  content_object_key TEXT NOT NULL UNIQUE,
  parsed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('planned', 'uploaded', 'finalized')
  ),
  content_digest TEXT,
  content_byte_length INTEGER,
  observation_count INTEGER,
  UNIQUE (
    source_snapshot_id,
    adapter_version,
    intent,
    idempotency_key
  )
);

CREATE TABLE source_observation_sets (
  id TEXT PRIMARY KEY,
  parse_operation_id TEXT NOT NULL UNIQUE
    REFERENCES source_parse_operations(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  parsed_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content_byte_length INTEGER NOT NULL,
  content_object_key TEXT NOT NULL UNIQUE,
  observation_count INTEGER NOT NULL,
  FOREIGN KEY (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  ) REFERENCES source_adapter_versions (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

CREATE TABLE source_host_pacing (
  hostname TEXT PRIMARY KEY,
  next_request_not_before TEXT NOT NULL,
  locked_by TEXT,
  lease_expires_at TEXT
);

CREATE TRIGGER source_fetch_attempts_are_immutable_on_update
BEFORE UPDATE ON source_fetch_attempts
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_fetch_attempt');
END;

CREATE TRIGGER source_fetch_attempts_are_immutable_on_delete
BEFORE DELETE ON source_fetch_attempts
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_fetch_attempt');
END;

CREATE TRIGGER source_snapshots_are_immutable_on_update
BEFORE UPDATE ON source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_snapshot');
END;

CREATE TRIGGER source_snapshots_are_immutable_on_delete
BEFORE DELETE ON source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_snapshot');
END;

CREATE TRIGGER source_observation_sets_are_immutable_on_update
BEFORE UPDATE ON source_observation_sets
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_observation_set');
END;

CREATE TRIGGER source_observation_sets_are_immutable_on_delete
BEFORE DELETE ON source_observation_sets
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_observation_set');
END;
