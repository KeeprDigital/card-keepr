SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 15
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_15', '$') END;

CREATE TABLE source_lifecycle_decisions (
  idempotency_key TEXT PRIMARY KEY,
  source_lineage TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  decided_at TEXT NOT NULL,
  UNIQUE (source_lineage, generation)
);
CREATE TRIGGER source_lifecycle_decisions_no_update BEFORE UPDATE ON source_lifecycle_decisions
BEGIN SELECT RAISE(ABORT, 'source_lifecycle_decision_immutable'); END;
CREATE TRIGGER source_lifecycle_decisions_no_delete BEFORE DELETE ON source_lifecycle_decisions
BEGIN SELECT RAISE(ABORT, 'source_lifecycle_decision_immutable'); END;
DROP TRIGGER reconciled_withdrawal_assertions_are_immutable_on_update;
DROP TRIGGER reconciled_withdrawal_assertions_are_immutable_on_delete;
ALTER TABLE reconciled_withdrawal_assertions RENAME TO prior_withdrawal_assertions;
CREATE TABLE reconciled_withdrawal_assertions (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('card', 'printing')),
  entity_id TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  source_observation_id TEXT NOT NULL,
  assertion TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('withdrawn', 'reinstated')),
  effective_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  published_catalogue_revision_id TEXT NOT NULL
    REFERENCES catalogue_revisions(id),
  PRIMARY KEY (entity_type, entity_id, source_observation_id),
  FOREIGN KEY (source_observation_set_id, source_snapshot_id)
    REFERENCES source_observation_sets (id, source_snapshot_id)
);

INSERT INTO reconciled_withdrawal_assertions SELECT * FROM prior_withdrawal_assertions;
DROP TABLE prior_withdrawal_assertions;

CREATE TRIGGER reconciled_withdrawal_assertions_are_immutable_on_update
BEFORE UPDATE ON reconciled_withdrawal_assertions
BEGIN
  SELECT RAISE(ABORT, 'withdrawal_assertion_immutable');
END;

CREATE TRIGGER reconciled_withdrawal_assertions_are_immutable_on_delete
BEFORE DELETE ON reconciled_withdrawal_assertions
BEGIN
  SELECT RAISE(ABORT, 'withdrawal_assertion_immutable');
END;

UPDATE catalogue_schema_state SET migration_level = 16 WHERE singleton = 1;
