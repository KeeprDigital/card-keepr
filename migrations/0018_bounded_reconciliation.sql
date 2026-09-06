SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 17
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_17', '$') END;

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
UPDATE catalogue_schema_state SET migration_level = 18 WHERE singleton = 1;
