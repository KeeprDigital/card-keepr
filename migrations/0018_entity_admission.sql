SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 17
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_17', '$') END;

CREATE TABLE entity_proposals (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  reference TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_lineage, reference)
);
CREATE TABLE entity_admission_decisions (
  proposal_id TEXT NOT NULL REFERENCES entity_proposals(id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  action TEXT NOT NULL CHECK(action IN ('admit', 'link', 'reject', 'reconsider')),
  actor TEXT NOT NULL CHECK(actor IN ('owner', 'automation')),
  rationale TEXT NOT NULL CHECK(length(rationale) > 0),
  decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY(proposal_id, generation)
);
CREATE TRIGGER entity_proposals_no_update BEFORE UPDATE ON entity_proposals
BEGIN SELECT RAISE(ABORT, 'entity_proposal_immutable'); END;
CREATE TRIGGER entity_proposals_no_delete BEFORE DELETE ON entity_proposals
BEGIN SELECT RAISE(ABORT, 'entity_proposal_immutable'); END;
CREATE TRIGGER entity_admission_decisions_no_update BEFORE UPDATE ON entity_admission_decisions
BEGIN SELECT RAISE(ABORT, 'entity_admission_decision_immutable'); END;
CREATE TRIGGER entity_admission_decisions_no_delete BEFORE DELETE ON entity_admission_decisions
BEGIN SELECT RAISE(ABORT, 'entity_admission_decision_immutable'); END;
CREATE TABLE entity_proposal_source_evidence (
  proposal_id TEXT NOT NULL REFERENCES entity_proposals(id),
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_id TEXT NOT NULL,
  PRIMARY KEY(proposal_id, ingestion_run_id, source_observation_id)
);
CREATE TRIGGER entity_proposal_source_evidence_no_update BEFORE UPDATE ON entity_proposal_source_evidence
BEGIN SELECT RAISE(ABORT, 'entity_proposal_evidence_immutable'); END;
CREATE TRIGGER entity_proposal_source_evidence_no_delete BEFORE DELETE ON entity_proposal_source_evidence
BEGIN SELECT RAISE(ABORT, 'entity_proposal_evidence_immutable'); END;
CREATE TABLE entity_admission_run_pins (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  games_json TEXT NOT NULL CHECK(json_valid(games_json)),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json))
);
CREATE TABLE entity_admission_pinned_decisions (
  ingestion_run_id TEXT NOT NULL REFERENCES entity_admission_run_pins(ingestion_run_id),
  proposal_id TEXT NOT NULL REFERENCES entity_proposals(id),
  generation INTEGER NOT NULL,
  PRIMARY KEY(ingestion_run_id, proposal_id)
);
CREATE TRIGGER entity_admission_run_pins_no_update BEFORE UPDATE ON entity_admission_run_pins
BEGIN SELECT RAISE(ABORT, 'admission_pin_immutable'); END;
CREATE TRIGGER entity_admission_run_pins_no_delete BEFORE DELETE ON entity_admission_run_pins
BEGIN SELECT RAISE(ABORT, 'admission_pin_immutable'); END;
CREATE TRIGGER entity_admission_pinned_decisions_no_update BEFORE UPDATE ON entity_admission_pinned_decisions
BEGIN SELECT RAISE(ABORT, 'admission_pin_immutable'); END;
CREATE TRIGGER entity_admission_pinned_decisions_no_delete BEFORE DELETE ON entity_admission_pinned_decisions
BEGIN SELECT RAISE(ABORT, 'admission_pin_immutable'); END;
UPDATE catalogue_schema_state SET migration_level = 18 WHERE singleton = 1;
