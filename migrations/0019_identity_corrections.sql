SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 18
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_18', '$') END;
CREATE TABLE identity_correction_decisions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  game TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  reviewed_json TEXT NOT NULL CHECK(json_valid(reviewed_json)),
  review_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  decided_at TEXT NOT NULL
);
CREATE TABLE identity_correction_run_pins (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  games_json TEXT NOT NULL CHECK(json_valid(games_json)),
  decision_cutoff INTEGER NOT NULL
);
CREATE TRIGGER identity_correction_decisions_no_update BEFORE UPDATE ON identity_correction_decisions
BEGIN SELECT RAISE(ABORT, 'identity_correction_immutable'); END;
CREATE TRIGGER identity_correction_decisions_no_delete BEFORE DELETE ON identity_correction_decisions
BEGIN SELECT RAISE(ABORT, 'identity_correction_immutable'); END;
CREATE TRIGGER identity_correction_run_pins_no_update BEFORE UPDATE ON identity_correction_run_pins
BEGIN SELECT RAISE(ABORT, 'identity_correction_pin_immutable'); END;
CREATE TRIGGER identity_correction_run_pins_no_delete BEFORE DELETE ON identity_correction_run_pins
BEGIN SELECT RAISE(ABORT, 'identity_correction_pin_immutable'); END;
CREATE TABLE revision_identity_corrections (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  entity_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('card', 'printing')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  PRIMARY KEY(catalogue_revision_id, entity_id)
);
UPDATE catalogue_schema_state SET migration_level = 19 WHERE singleton = 1;
