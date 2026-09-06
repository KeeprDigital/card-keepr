SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 15
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_15', '$') END;

-- Allocation keys locate a prior decision; entity IDs contain no source facts.
-- These operational records are included in the complete D1 backup/restore.
CREATE TABLE canonical_identity_allocations (
  allocation_key TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL UNIQUE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('card', 'printing')),
  allocated_at TEXT NOT NULL
);
CREATE TABLE canonical_source_mappings (
  entity_id TEXT NOT NULL,
  source_observation_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('card', 'printing')),
  source_lineage TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_set_id TEXT NOT NULL REFERENCES source_observation_sets(id),
  locator TEXT,
  variant_key TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  mapped_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, source_observation_id)
);
CREATE INDEX canonical_source_mapping_alias ON canonical_source_mappings(source_lineage, locator, variant_key);
CREATE TRIGGER canonical_identity_allocations_no_update BEFORE UPDATE ON canonical_identity_allocations
BEGIN SELECT RAISE(ABORT, 'canonical_identity_allocation_immutable'); END;
CREATE TRIGGER canonical_identity_allocations_no_delete BEFORE DELETE ON canonical_identity_allocations
BEGIN SELECT RAISE(ABORT, 'canonical_identity_allocation_immutable'); END;
CREATE TRIGGER canonical_source_mappings_no_update BEFORE UPDATE ON canonical_source_mappings
BEGIN SELECT RAISE(ABORT, 'canonical_source_mapping_immutable'); END;
CREATE TRIGGER canonical_source_mappings_no_delete BEFORE DELETE ON canonical_source_mappings
BEGIN SELECT RAISE(ABORT, 'canonical_source_mapping_immutable'); END;
CREATE TABLE canonical_identity_reviews (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  source_lineage TEXT NOT NULL,
  source_observation_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  candidate_printing_ids_json TEXT NOT NULL CHECK (json_valid(candidate_printing_ids_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE canonical_identity_review_runs (
  review_id TEXT NOT NULL REFERENCES canonical_identity_reviews(id),
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  source_observation_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  PRIMARY KEY(review_id, ingestion_run_id)
);
CREATE TRIGGER canonical_identity_review_runs_no_update BEFORE UPDATE ON canonical_identity_review_runs
BEGIN SELECT RAISE(ABORT, 'canonical_identity_review_run_immutable'); END;
CREATE TRIGGER canonical_identity_review_runs_no_delete BEFORE DELETE ON canonical_identity_review_runs
BEGIN SELECT RAISE(ABORT, 'canonical_identity_review_run_immutable'); END;
CREATE TABLE canonical_identity_decisions (
  review_id TEXT PRIMARY KEY REFERENCES canonical_identity_reviews(id),
  printing_id TEXT NOT NULL REFERENCES reconciled_printings(id),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  decided_at TEXT NOT NULL
);
CREATE TRIGGER canonical_identity_reviews_no_update BEFORE UPDATE ON canonical_identity_reviews
BEGIN SELECT RAISE(ABORT, 'canonical_identity_review_immutable'); END;
CREATE TRIGGER canonical_identity_reviews_no_delete BEFORE DELETE ON canonical_identity_reviews
BEGIN SELECT RAISE(ABORT, 'canonical_identity_review_immutable'); END;
CREATE TRIGGER canonical_identity_decisions_no_update BEFORE UPDATE ON canonical_identity_decisions
BEGIN SELECT RAISE(ABORT, 'canonical_identity_decision_immutable'); END;
CREATE TRIGGER canonical_identity_decisions_no_delete BEFORE DELETE ON canonical_identity_decisions
BEGIN SELECT RAISE(ABORT, 'canonical_identity_decision_immutable'); END;

-- Unknown publisher numbers sort by their opaque Card ID without changing the
-- consumer document. Existing records keep their original sort values.
DROP INDEX revision_card_query_documents_by_order;
DROP INDEX revision_card_query_documents_by_identity;
ALTER TABLE revision_card_query_documents DROP COLUMN sort_identity_value;
ALTER TABLE revision_card_query_documents ADD COLUMN sort_identity_value TEXT GENERATED ALWAYS AS (
  COALESCE(CAST(json_extract(summary_json, '$.official_identity.value') AS TEXT), card_id)
) VIRTUAL NOT NULL;
CREATE INDEX revision_card_query_documents_by_order ON revision_card_query_documents(
  catalogue_revision_id, sort_game, sort_identity_kind, sort_identity_value, sort_id);
CREATE INDEX revision_card_query_documents_by_identity ON revision_card_query_documents(
  catalogue_revision_id, sort_identity_kind, sort_identity_value, sort_game, sort_id);
UPDATE catalogue_schema_state SET migration_level = 16 WHERE singleton = 1;
