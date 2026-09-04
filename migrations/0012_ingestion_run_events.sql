SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 11
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_11', '$') END;

-- ADR 0008: regenerate pre-Go-Live runs; never invent historical events or
-- erase existing data. Release execution uses its canonical lease, not a run.
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ingestion_runs)
    AND EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1 AND active_ingestion_run_id IS NULL)
  THEN 1 ELSE json_extract('{}', 'ingestion_run_event_migration_requires_empty_runs') END;

-- Preserve the physical identity anchor and every inbound foreign key.
DROP TRIGGER guard_terminal_ingestion_immutability;
DROP TRIGGER guard_reserved_approval;
DROP TRIGGER guard_fixed_candidate;
DROP TRIGGER guard_ingestion_deletion;
DROP INDEX ingestion_runs_by_state;
ALTER TABLE ingestion_runs DROP COLUMN state;
ALTER TABLE ingestion_runs DROP COLUMN selected_games_json;
ALTER TABLE ingestion_runs DROP COLUMN candidate_digest;
ALTER TABLE ingestion_runs DROP COLUMN candidate_created_at;
ALTER TABLE ingestion_runs DROP COLUMN approval_deadline;
ALTER TABLE ingestion_runs DROP COLUMN approval_json;
ALTER TABLE ingestion_runs DROP COLUMN published_revision_id;
ALTER TABLE ingestion_runs DROP COLUMN export_manifest_digest;
ALTER TABLE ingestion_runs DROP COLUMN terminal_at;
ALTER TABLE ingestion_runs DROP COLUMN candidate_json;
ALTER TABLE ingestion_runs DROP COLUMN failure_code;
ALTER TABLE ingestion_runs DROP COLUMN progress_json;
ALTER TABLE ingestion_runs DROP COLUMN warnings_json;
ALTER TABLE ingestion_runs DROP COLUMN approval_history_json;
ALTER TABLE ingestion_runs DROP COLUMN publication_outcome;
ALTER TABLE ingestion_runs DROP COLUMN resulting_revision_id;
ALTER TABLE ingestion_runs DROP COLUMN freshness_checked_at;
ALTER TABLE ingestion_runs DROP COLUMN publication_revision_id;
ALTER TABLE ingestion_runs DROP COLUMN publication_started_at;
ALTER TABLE ingestion_runs DROP COLUMN publication_reconcile_after;
ALTER TABLE ingestion_runs DROP COLUMN publication_manifest_digest;
ALTER TABLE ingestion_runs DROP COLUMN publication_writer_token;
ALTER TABLE ingestion_runs DROP COLUMN candidate_catalogue_digest;

CREATE TRIGGER ingestion_run_identity_is_immutable
BEFORE UPDATE ON ingestion_runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.expected_current_revision_id IS NOT OLD.expected_current_revision_id
  OR NEW.linked_run_id IS NOT OLD.linked_run_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.operational_request_id IS NOT OLD.operational_request_id
  OR (OLD.approval_idempotency_key IS NOT NULL
    AND NEW.approval_idempotency_key IS NOT OLD.approval_idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_identity_immutable');
END;
CREATE TRIGGER ingestion_run_identity_is_not_deleted
BEFORE DELETE ON ingestion_runs
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_identity_immutable');
END;

CREATE TABLE ingestion_run_events (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  event_id TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('created', 'stage_changed', 'collection_paused', 'collection_resumed', 'collection_terminated', 'candidate_prepared', 'candidate_blocked', 'approval_reserved', 'rejected', 'expired', 'failed', 'published')),
  occurred_at TEXT NOT NULL,
  from_state TEXT CHECK (from_state IN ('planning', 'collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing', 'published', 'rejected', 'expired', 'failed')),
  to_state TEXT NOT NULL CHECK (to_state IN ('planning', 'collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing', 'published', 'rejected', 'expired', 'failed')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  PRIMARY KEY (ingestion_run_id, sequence_number)
);
CREATE TRIGGER ingestion_run_events_are_immutable_on_update
BEFORE UPDATE ON ingestion_run_events
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_event_immutable');
END;
CREATE TRIGGER ingestion_run_events_are_immutable_on_delete
BEFORE DELETE ON ingestion_run_events
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_event_immutable');
END;

-- No FK from current to events: a mutation updates current, checks authority,
-- then appends its exact event in the same repository transaction.
CREATE TABLE ingestion_run_current (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 1),
  last_event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planning', 'collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing', 'published', 'rejected', 'expired', 'failed')),
  previous_state TEXT CHECK (previous_state IN ('planning', 'collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing', 'published', 'rejected', 'expired', 'failed')),
  completed_stage_count INTEGER NOT NULL CHECK (completed_stage_count BETWEEN 0 AND 6),
  candidate_digest TEXT,
  candidate_catalogue_digest TEXT,
  candidate_created_at TEXT,
  approval_deadline TEXT,
  candidate_payload_event_sequence INTEGER CHECK (candidate_payload_event_sequence >= 1),
  diagnostics_event_sequence INTEGER CHECK (diagnostics_event_sequence >= 1),
  approved_at TEXT,
  approved_candidate_digest TEXT,
  approved_expected_revision_id TEXT,
  failure_code TEXT,
  terminal_at TEXT,
  publication_revision_id TEXT,
  publication_started_at TEXT,
  publication_reconcile_after TEXT,
  publication_manifest_digest TEXT,
  publication_writer_token TEXT,
  published_revision_id TEXT,
  export_manifest_digest TEXT,
  publication_outcome TEXT CHECK (publication_outcome IN ('revision', 'no_change')),
  resulting_revision_id TEXT,
  freshness_checked_at TEXT
);
CREATE INDEX ingestion_runs_by_state
ON ingestion_run_current (state, publication_reconcile_after, ingestion_run_id);

CREATE TABLE ingestion_run_selected_games (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  game TEXT NOT NULL CHECK (game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')),
  PRIMARY KEY (ingestion_run_id, ordinal),
  UNIQUE (ingestion_run_id, game)
);

CREATE TABLE ingestion_run_event_payload_chunks (
  ingestion_run_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
  payload_kind TEXT NOT NULL CHECK (payload_kind IN ('candidate', 'diagnostics')),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 524288),
  PRIMARY KEY (ingestion_run_id, event_sequence, payload_kind, chunk_index),
  FOREIGN KEY (ingestion_run_id, event_sequence)
    REFERENCES ingestion_run_events(ingestion_run_id, sequence_number)
);
CREATE TRIGGER ingestion_run_event_payload_chunks_are_immutable_on_update
BEFORE UPDATE ON ingestion_run_event_payload_chunks
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_event_payload_immutable');
END;
CREATE TRIGGER ingestion_run_event_payload_chunks_are_immutable_on_delete
BEFORE DELETE ON ingestion_run_event_payload_chunks
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_event_payload_immutable');
END;

-- Read rendering preserves administration codecs without persisted JSON blobs
-- or writable compatibility triggers. Authority checks use typed current rows.
CREATE VIEW ingestion_run_read AS
SELECT identity.id, current.state,
  (SELECT json_group_array(game) FROM (
    SELECT game FROM ingestion_run_selected_games
    WHERE ingestion_run_id = identity.id ORDER BY ordinal
  )) AS selected_games_json,
  identity.started_at, identity.expected_current_revision_id, identity.linked_run_id,
  identity.idempotency_key, current.candidate_digest, current.candidate_created_at,
  current.approval_deadline,
  CASE WHEN current.approved_at IS NULL THEN NULL ELSE json_object(
    'candidate_digest', current.approved_candidate_digest,
    'expected_current_revision_id', current.approved_expected_revision_id,
    'approved_at', current.approved_at
  ) END AS approval_json,
  current.published_revision_id, current.export_manifest_digest, current.terminal_at,
  COALESCE((SELECT group_concat(content, '') FROM (
    SELECT content FROM ingestion_run_event_payload_chunks
    WHERE ingestion_run_id = identity.id
      AND event_sequence = current.candidate_payload_event_sequence
      AND payload_kind = 'candidate' ORDER BY chunk_index
  )), '{}') AS candidate_json,
  identity.approval_idempotency_key, current.failure_code,
  json_object('completed_stages', json((SELECT json_group_array(value) FROM (
    SELECT value FROM json_each('["planning","collecting","parsing","reconciling","awaiting_approval","publishing"]')
    WHERE CAST(key AS INTEGER) < current.completed_stage_count ORDER BY CAST(key AS INTEGER)
  ))), 'current_stage', current.state) AS progress_json,
  COALESCE((SELECT group_concat(content, '') FROM (
    SELECT content FROM ingestion_run_event_payload_chunks
    WHERE ingestion_run_id = identity.id
      AND event_sequence = current.diagnostics_event_sequence
      AND payload_kind = 'diagnostics' ORDER BY chunk_index
  )), '[]') AS warnings_json,
  (SELECT json_group_array(json(decision)) FROM (
    SELECT json_extract(payload_json, '$.decision') AS decision FROM ingestion_run_events
    WHERE ingestion_run_id = identity.id AND json_type(payload_json, '$.decision') = 'object'
    ORDER BY sequence_number
  )) AS approval_history_json,
  current.publication_outcome, current.resulting_revision_id, current.freshness_checked_at,
  current.publication_revision_id, current.publication_started_at, current.publication_reconcile_after,
  current.publication_manifest_digest, current.publication_writer_token,
  current.candidate_catalogue_digest, identity.operational_request_id
FROM ingestion_runs AS identity
JOIN ingestion_run_current AS current ON current.ingestion_run_id = identity.id;

UPDATE catalogue_schema_state SET migration_level = 12 WHERE singleton = 1;
