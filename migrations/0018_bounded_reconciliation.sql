SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 17
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_17', '$') END;

-- A retained reservation belongs to each run; the legacy singleton is only
-- the first live reservation used by conservative release/recovery idle gates.
CREATE TABLE ingestion_collection_reservations (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id)
);
INSERT INTO ingestion_collection_reservations SELECT ingestion_run_id FROM ingestion_run_current;
CREATE TRIGGER reserve_ingestion_collection AFTER INSERT ON ingestion_run_current
BEGIN INSERT INTO ingestion_collection_reservations VALUES (NEW.ingestion_run_id); END;
CREATE TRIGGER keep_live_ingestion_reservation AFTER UPDATE OF active_ingestion_run_id ON operation_state
WHEN NEW.active_ingestion_run_id IS NULL AND EXISTS (SELECT 1 FROM ingestion_run_current WHERE state IN ('collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing'))
BEGIN UPDATE operation_state SET active_ingestion_run_id = (
  SELECT reservation.ingestion_run_id FROM ingestion_collection_reservations AS reservation
  JOIN ingestion_run_current AS run ON run.ingestion_run_id = reservation.ingestion_run_id
  WHERE run.state IN ('collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing')
  ORDER BY reservation.ingestion_run_id LIMIT 1
) WHERE singleton = 1; END;
CREATE TABLE game_candidate_slots (
  supported_game TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id)
);
CREATE TRIGGER release_game_candidate_slot AFTER UPDATE OF state ON ingestion_run_current
WHEN NEW.state IN ('failed', 'rejected', 'expired', 'published')
BEGIN DELETE FROM game_candidate_slots WHERE ingestion_run_id = NEW.ingestion_run_id; END;

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
CREATE TRIGGER claim_game_candidate_slot BEFORE INSERT ON reconciliation_operations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM game_candidate_slots AS slot JOIN ingestion_run_read AS run ON run.id = NEW.ingestion_run_id,
      json_each(run.selected_games_json) AS game
    WHERE slot.supported_game = game.value AND slot.ingestion_run_id <> NEW.ingestion_run_id
  ) THEN json_extract('{}', 'game_candidate_slot_occupied') ELSE 1 END;
  INSERT OR IGNORE INTO game_candidate_slots (supported_game, ingestion_run_id)
    SELECT game.value, NEW.ingestion_run_id FROM ingestion_run_read AS run, json_each(run.selected_games_json) AS game
    WHERE run.id = NEW.ingestion_run_id;
END;
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
CREATE TRIGGER reconciliation_partition_insert_guard BEFORE INSERT ON reconciliation_record_partitions
WHEN NOT EXISTS (SELECT 1 FROM reconciliation_operations WHERE ingestion_run_id = NEW.ingestion_run_id AND state = 'preparing')
BEGIN SELECT RAISE(ABORT, 'reconciliation_not_preparing'); END;
CREATE TRIGGER reconciliation_partition_progress AFTER INSERT ON reconciliation_record_partitions
BEGIN UPDATE reconciliation_operations SET completed_partitions = completed_partitions + 1 WHERE ingestion_run_id = NEW.ingestion_run_id; END;
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
CREATE TRIGGER reconciliation_operation_failure AFTER UPDATE OF state ON ingestion_run_current
WHEN NEW.state = 'failed'
BEGIN UPDATE reconciliation_operations SET state = 'failed', failure_code = NEW.failure_code
  WHERE ingestion_run_id = NEW.ingestion_run_id AND state = 'preparing'; END;
UPDATE catalogue_schema_state SET migration_level = 18 WHERE singleton = 1;
