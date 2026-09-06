SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 19
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_19', '$') END;

-- A retained reservation belongs to each run; the legacy singleton is only
-- the first live reservation used by conservative release/recovery idle gates.
CREATE TABLE ingestion_collection_reservations (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id)
);
INSERT INTO ingestion_collection_reservations SELECT ingestion_run_id FROM ingestion_run_current;
CREATE TABLE game_candidate_slots (
  supported_game TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id)
);

CREATE TABLE reconciliation_operations (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'paused', 'sealed', 'failed', 'abandoned')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  completed_partitions INTEGER NOT NULL DEFAULT 0 CHECK (completed_partitions >= 0),
  candidate_digest TEXT,
  manifest_digest TEXT,
  input_manifest_digest TEXT,
  definition_pins_json TEXT NOT NULL CHECK (json_valid(definition_pins_json)),
  observation_cutoff INTEGER NOT NULL,
  identity_decision_cutoff INTEGER NOT NULL,
  authority_decision_cutoff INTEGER NOT NULL,
  failure_code TEXT
);
CREATE TRIGGER reconciliation_operation_identity_immutable BEFORE UPDATE ON reconciliation_operations
WHEN NEW.id <> OLD.id OR NEW.ingestion_run_id <> OLD.ingestion_run_id
  OR NEW.created_at <> OLD.created_at OR NEW.deadline <> OLD.deadline
  OR NEW.definition_pins_json <> OLD.definition_pins_json
  OR NEW.observation_cutoff <> OLD.observation_cutoff
  OR NEW.identity_decision_cutoff <> OLD.identity_decision_cutoff
  OR NEW.authority_decision_cutoff <> OLD.authority_decision_cutoff
BEGIN SELECT RAISE(ABORT, 'reconciliation_operation_identity_immutable'); END;
CREATE TRIGGER reconciliation_verified_input_immutable BEFORE UPDATE ON reconciliation_operations
WHEN OLD.input_manifest_digest IS NOT NULL AND NEW.input_manifest_digest IS NOT OLD.input_manifest_digest
BEGIN SELECT RAISE(ABORT, 'reconciliation_verified_input_immutable'); END;
CREATE TRIGGER reconciliation_operation_no_delete BEFORE DELETE ON reconciliation_operations
BEGIN SELECT RAISE(ABORT, 'reconciliation_operation_audit_retained'); END;
CREATE TABLE reconciliation_record_partitions (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'array'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 2 AND 524288),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 500),
  PRIMARY KEY (ingestion_run_id, ordinal),
  CHECK (length(CAST(content AS BLOB)) = byte_length),
  CHECK (json_array_length(content) = record_count)
);
CREATE TRIGGER reconciliation_partition_no_update BEFORE UPDATE ON reconciliation_record_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_partition_immutable'); END;
CREATE TRIGGER reconciliation_partition_no_delete BEFORE DELETE ON reconciliation_record_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_partition_audit_retained'); END;
CREATE TABLE reconciliation_actions (
  idempotency_key TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json))
);
CREATE TRIGGER reconciliation_action_no_update BEFORE UPDATE ON reconciliation_actions
BEGIN SELECT RAISE(ABORT, 'reconciliation_action_immutable'); END;
CREATE TRIGGER reconciliation_action_no_delete BEFORE DELETE ON reconciliation_actions
BEGIN SELECT RAISE(ABORT, 'reconciliation_action_immutable'); END;
CREATE TABLE reconciliation_preparation_batches (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (ingestion_run_id, ordinal)
);
CREATE TRIGGER reconciliation_preparation_no_update BEFORE UPDATE ON reconciliation_preparation_batches
BEGIN SELECT RAISE(ABORT, 'reconciliation_preparation_immutable'); END;
CREATE TRIGGER reconciliation_preparation_no_delete BEFORE DELETE ON reconciliation_preparation_batches
BEGIN SELECT RAISE(ABORT, 'reconciliation_preparation_audit_retained'); END;
CREATE TABLE reconciliation_input_partitions (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'array'
    AND length(CAST(content AS BLOB)) <= 524288 AND json_array_length(content) <= 500),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (ingestion_run_id, ordinal)
);
CREATE TRIGGER reconciliation_input_no_update BEFORE UPDATE ON reconciliation_input_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_input_immutable'); END;
CREATE TRIGGER reconciliation_input_no_delete BEFORE DELETE ON reconciliation_input_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_input_audit_retained'); END;
CREATE INDEX reconciliation_input_kind_cursor ON reconciliation_input_partitions(ingestion_run_id, kind, ordinal);
CREATE TABLE reconciliation_observation_origins (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  observation_id TEXT NOT NULL,
  observation_set_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  PRIMARY KEY (ingestion_run_id, observation_id)
);
CREATE TRIGGER reconciliation_observation_origin_no_update BEFORE UPDATE ON reconciliation_observation_origins
BEGIN SELECT RAISE(ABORT, 'reconciliation_observation_origin_immutable'); END;
CREATE TRIGGER reconciliation_observation_origin_no_delete BEFORE DELETE ON reconciliation_observation_origins
BEGIN SELECT RAISE(ABORT, 'reconciliation_observation_origin_audit_retained'); END;
CREATE TABLE reconciliation_normalized_observations (
  ingestion_run_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  card_erratum_target_digest TEXT CHECK (card_erratum_target_digest IS NULL OR length(card_erratum_target_digest) = 64),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (ingestion_run_id, observation_id),
  FOREIGN KEY (ingestion_run_id, observation_id) REFERENCES reconciliation_observation_origins(ingestion_run_id, observation_id)
);
CREATE INDEX reconciliation_normalized_card_erratum_target
ON reconciliation_normalized_observations (ingestion_run_id, card_erratum_target_digest, observation_id);
CREATE TRIGGER reconciliation_normalized_no_update BEFORE UPDATE ON reconciliation_normalized_observations
BEGIN SELECT RAISE(ABORT, 'reconciliation_normalized_observation_immutable'); END;
CREATE TRIGGER reconciliation_normalized_no_delete BEFORE DELETE ON reconciliation_normalized_observations
BEGIN SELECT RAISE(ABORT, 'reconciliation_normalized_observation_audit_retained'); END;
CREATE TABLE game_candidates (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  supported_game TEXT NOT NULL,
  expected_game_revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'paused', 'sealed', 'failed', 'abandoned', 'rejected', 'expired', 'published')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  manifest_digest TEXT CHECK (manifest_digest IS NULL OR length(manifest_digest) = 64),
  preparation_manifest_digest TEXT CHECK (preparation_manifest_digest IS NULL OR length(preparation_manifest_digest) = 64),
  partition_count INTEGER NOT NULL DEFAULT 0 CHECK (partition_count >= 0),
  UNIQUE (ingestion_run_id, supported_game)
);
CREATE TABLE reconciliation_verified_documents (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  observation_set_id TEXT NOT NULL,
  provenance_digest TEXT NOT NULL CHECK (length(provenance_digest) = 64),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  partition_count INTEGER NOT NULL CHECK (partition_count > 0),
  PRIMARY KEY (ingestion_run_id, observation_set_id)
);
CREATE TRIGGER reconciliation_document_no_update BEFORE UPDATE ON reconciliation_verified_documents
BEGIN SELECT RAISE(ABORT, 'reconciliation_document_immutable'); END;
CREATE TRIGGER reconciliation_document_no_delete BEFORE DELETE ON reconciliation_verified_documents
BEGIN SELECT RAISE(ABORT, 'reconciliation_document_audit_retained'); END;
CREATE TABLE reconciliation_document_partitions (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  observation_set_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind = 'document'),
  content TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'array'
    AND length(CAST(content AS BLOB)) <= 524288 AND json_array_length(content) <= 500),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (ingestion_run_id, observation_set_id, ordinal)
);
CREATE TRIGGER reconciliation_document_partition_no_update BEFORE UPDATE ON reconciliation_document_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_document_partition_immutable'); END;
CREATE TRIGGER reconciliation_document_partition_no_delete BEFORE DELETE ON reconciliation_document_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_document_partition_audit_retained'); END;
CREATE TABLE reconciliation_text_chunks (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 131072),
  PRIMARY KEY (ingestion_run_id, sha256, ordinal)
);
CREATE TRIGGER reconciliation_text_no_update BEFORE UPDATE ON reconciliation_text_chunks
BEGIN SELECT RAISE(ABORT, 'reconciliation_text_immutable'); END;
CREATE TRIGGER reconciliation_text_no_delete BEFORE DELETE ON reconciliation_text_chunks
BEGIN SELECT RAISE(ABORT, 'reconciliation_text_audit_retained'); END;
CREATE TRIGGER game_candidate_identity_immutable BEFORE UPDATE ON game_candidates
WHEN NEW.id <> OLD.id OR NEW.ingestion_run_id <> OLD.ingestion_run_id OR NEW.supported_game <> OLD.supported_game
  OR NEW.expected_game_revision_id <> OLD.expected_game_revision_id OR NEW.created_at <> OLD.created_at OR NEW.deadline <> OLD.deadline
  OR (OLD.manifest_digest IS NOT NULL AND (NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.partition_count <> OLD.partition_count
    OR NEW.preparation_manifest_digest IS NOT OLD.preparation_manifest_digest))
BEGIN SELECT RAISE(ABORT, 'game_candidate_identity_immutable'); END;
CREATE TRIGGER game_candidate_no_delete BEFORE DELETE ON game_candidates
BEGIN SELECT RAISE(ABORT, 'game_candidate_audit_retained'); END;
CREATE TABLE game_candidate_entity_scopes (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  kind TEXT NOT NULL CHECK (kind IN ('cards', 'printings')),
  id TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, kind, id)
);
CREATE TRIGGER game_candidate_scope_no_update BEFORE UPDATE ON game_candidate_entity_scopes
BEGIN SELECT RAISE(ABORT, 'game_candidate_scope_immutable'); END;
CREATE TRIGGER game_candidate_scope_no_delete BEFORE DELETE ON game_candidate_entity_scopes
BEGIN SELECT RAISE(ABORT, 'game_candidate_scope_audit_retained'); END;
CREATE TABLE game_candidate_partitions (
  candidate_id TEXT NOT NULL REFERENCES game_candidates(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'array'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 2 AND 524288 AND length(CAST(content AS BLOB)) = byte_length),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 500 AND json_array_length(content) = record_count),
  PRIMARY KEY (candidate_id, ordinal)
);
CREATE TRIGGER game_candidate_partition_no_update BEFORE UPDATE ON game_candidate_partitions
BEGIN SELECT RAISE(ABORT, 'game_candidate_partition_immutable'); END;
CREATE TRIGGER game_candidate_partition_no_delete BEFORE DELETE ON game_candidate_partitions
BEGIN SELECT RAISE(ABORT, 'game_candidate_partition_audit_retained'); END;
CREATE TABLE reconciliation_reducer_state (
  ingestion_run_id TEXT NOT NULL REFERENCES reconciliation_operations(ingestion_run_id),
  namespace TEXT NOT NULL,
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64),
  observation_ordinal INTEGER NOT NULL CHECK (observation_ordinal > 0),
  group_digest TEXT CHECK (group_digest IS NULL OR length(group_digest) = 64),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (ingestion_run_id, namespace, key_digest, observation_ordinal)
);
CREATE INDEX reconciliation_reducer_state_group
ON reconciliation_reducer_state (ingestion_run_id, namespace, group_digest, key_digest, observation_ordinal);
CREATE TRIGGER reconciliation_reducer_state_no_update BEFORE UPDATE ON reconciliation_reducer_state
BEGIN SELECT RAISE(ABORT, 'reconciliation_reducer_state_immutable'); END;
CREATE TRIGGER reconciliation_reducer_state_no_delete BEFORE DELETE ON reconciliation_reducer_state
BEGIN SELECT RAISE(ABORT, 'reconciliation_reducer_state_audit_retained'); END;
CREATE INDEX reconciliation_source_image_lookup ON source_snapshots (ingestion_run_id, source_lineage, request_url);
CREATE INDEX reconciliation_reducer_entity_cursor ON reconciliation_reducer_state
(ingestion_run_id, namespace, json_extract(content, '$.value.id'), observation_ordinal);
UPDATE catalogue_schema_state SET migration_level = 20 WHERE singleton = 1;
