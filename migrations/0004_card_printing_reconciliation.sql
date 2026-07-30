PRAGMA foreign_keys = ON;

ALTER TABLE source_adapter_versions
ADD COLUMN adapter_origin TEXT NOT NULL DEFAULT 'production'
CHECK (adapter_origin IN ('production', 'synthetic_fixture'));

ALTER TABLE ingestion_evidence_plans
ADD COLUMN plan_origin TEXT NOT NULL DEFAULT 'production'
CHECK (plan_origin IN ('production', 'synthetic_fixture'));

ALTER TABLE ingestion_runs
ADD COLUMN candidate_catalogue_digest TEXT;

DROP TRIGGER guard_candidate_finalization;

CREATE TRIGGER guard_candidate_finalization
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state = 'reconciling'
  AND NEW.state = 'awaiting_approval'
  AND (
    NEW.candidate_digest IS NULL
    OR NEW.candidate_catalogue_digest IS NULL
    OR NEW.candidate_created_at IS NULL
    OR NEW.approval_deadline IS NULL
    OR NEW.approval_deadline <> strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      NEW.candidate_created_at,
      '+7 days'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_candidate_deadline');
END;

DROP TRIGGER guard_fixed_candidate;

CREATE TRIGGER guard_fixed_candidate
BEFORE UPDATE OF
  candidate_digest,
  candidate_catalogue_digest,
  candidate_created_at,
  approval_deadline,
  expected_current_revision_id,
  candidate_json,
  selected_games_json,
  warnings_json
ON ingestion_runs
WHEN OLD.state IN (
  'awaiting_approval',
  'publishing',
  'published',
  'rejected',
  'expired',
  'failed'
)
  AND (
    OLD.candidate_digest IS NOT NEW.candidate_digest
    OR OLD.candidate_catalogue_digest
      IS NOT NEW.candidate_catalogue_digest
    OR OLD.candidate_created_at IS NOT NEW.candidate_created_at
    OR OLD.approval_deadline IS NOT NEW.approval_deadline
    OR OLD.expected_current_revision_id
      IS NOT NEW.expected_current_revision_id
    OR OLD.candidate_json IS NOT NEW.candidate_json
    OR OLD.selected_games_json IS NOT NEW.selected_games_json
    OR OLD.warnings_json IS NOT NEW.warnings_json
  )
BEGIN
  SELECT RAISE(ABORT, 'candidate_immutable');
END;

DROP TRIGGER guard_no_change_result;

CREATE TRIGGER guard_no_change_result
BEFORE INSERT ON ingestion_no_change_results
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_runs AS run
  JOIN operation_state AS operation ON operation.singleton = 1
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  JOIN catalogue_revisions AS revision
    ON revision.id = catalogue.current_revision_id
  WHERE run.id = NEW.ingestion_run_id
    AND run.state = 'awaiting_approval'
    AND run.candidate_digest = NEW.candidate_digest
    AND run.expected_current_revision_id = NEW.catalogue_revision_id
    AND operation.active_ingestion_run_id = run.id
    AND operation.recovery_health = 'healthy'
    AND catalogue.current_revision_id = NEW.catalogue_revision_id
    AND revision.content_digest = run.candidate_catalogue_digest
    AND NEW.checked_at < run.approval_deadline
)
BEGIN
  SELECT RAISE(ABORT, 'no_change_guard_failed');
END;

INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'fixture-one-piece-json@1',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'synthetic-fixture-card-document@1',
    'synthetic_fixture'
  ),
  (
    'fusion-world-en@1',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'fusion-world-card-document@1',
    'production'
  ),
  (
    'digimon-en@1',
    'digimon-en',
    'digimon',
    'digimon@1',
    'digimon-card-document@1',
    'production'
  ),
  (
    'gundam-en-asia@1',
    'gundam-en-asia',
    'gundam',
    'gundam@1',
    'gundam-card-document@1',
    'production'
  ),
  (
    'gundam-en-us@1',
    'gundam-en-us',
    'gundam',
    'gundam@1',
    'gundam-card-document@1',
    'production'
  ),
  (
    'fixture-fusion-world-json@1',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'synthetic-fixture-card-document@1',
    'synthetic_fixture'
  ),
  (
    'fixture-digimon-json@1',
    'digimon-en',
    'digimon',
    'digimon@1',
    'synthetic-fixture-card-document@1',
    'synthetic_fixture'
  ),
  (
    'fixture-gundam-en-asia-json@1',
    'gundam-en-asia',
    'gundam',
    'gundam@1',
    'synthetic-fixture-card-document@1',
    'synthetic_fixture'
  ),
  (
    'fixture-gundam-en-us-json@1',
    'gundam-en-us',
    'gundam',
    'gundam@1',
    'synthetic-fixture-card-document@1',
    'synthetic_fixture'
  );

CREATE TRIGGER ingestion_evidence_plan_origin_matches_adapter
BEFORE INSERT ON ingestion_evidence_plans
WHEN NOT EXISTS (
  SELECT 1
  FROM source_adapter_versions AS adapter
  WHERE adapter.adapter_version = NEW.adapter_version
    AND adapter.adapter_origin = NEW.plan_origin
)
BEGIN
  SELECT RAISE(ABORT, 'evidence_plan_origin_mismatch');
END;

CREATE TRIGGER ingestion_evidence_plan_origin_is_immutable
BEFORE UPDATE OF plan_origin ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'evidence_plan_origin_immutable');
END;

CREATE TABLE reconciled_cards (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  official_identity_kind TEXT NOT NULL,
  official_identity_value TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawal_revision_id TEXT REFERENCES catalogue_revisions(id),
  withdrawal_evidence_json TEXT,
  UNIQUE (
    supported_game,
    official_identity_kind,
    official_identity_value
  )
);

CREATE TABLE reconciled_printings (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES reconciled_cards(id),
  source_lineage TEXT NOT NULL,
  artwork_fingerprint TEXT NOT NULL,
  printed_fields_digest TEXT NOT NULL,
  rarity_normalized TEXT,
  treatment TEXT,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawal_revision_id TEXT REFERENCES catalogue_revisions(id),
  withdrawal_evidence_json TEXT
);

CREATE INDEX reconciled_printing_compatibility
ON reconciled_printings (
  card_id,
  source_lineage,
  artwork_fingerprint,
  printed_fields_digest,
  rarity_normalized,
  treatment
);

CREATE TABLE reconciled_printing_locators (
  printing_id TEXT NOT NULL REFERENCES reconciled_printings(id),
  source_lineage TEXT NOT NULL,
  locator TEXT NOT NULL,
  variant_key TEXT,
  variant_identity TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  PRIMARY KEY (source_lineage, locator, variant_identity)
);

CREATE TABLE reconciled_printing_memberships (
  printing_id TEXT NOT NULL REFERENCES reconciled_printings(id),
  source_lineage TEXT NOT NULL,
  source_observation_id TEXT NOT NULL,
  relationship_kind TEXT NOT NULL CHECK (
    relationship_kind IN (
      'product',
      'distribution_context',
      'source_bucket'
    )
  ),
  relationship_value TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  PRIMARY KEY (
    printing_id,
    source_lineage,
    source_observation_id,
    relationship_kind,
    relationship_value
  )
);

CREATE TABLE reconciled_card_observations (
  card_id TEXT NOT NULL REFERENCES reconciled_cards(id),
  source_lineage TEXT NOT NULL,
  source_observation_id TEXT NOT NULL,
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  canonical_facts_json TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  PRIMARY KEY (card_id, source_lineage, source_observation_id)
);

CREATE TABLE reconciled_withdrawal_assertions (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('card', 'printing')),
  entity_id TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  source_observation_id TEXT NOT NULL,
  assertion TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state = 'withdrawn'),
  effective_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  published_catalogue_revision_id TEXT NOT NULL
    REFERENCES catalogue_revisions(id),
  PRIMARY KEY (entity_type, entity_id, source_observation_id),
  FOREIGN KEY (source_observation_set_id, source_snapshot_id)
    REFERENCES source_observation_sets (id, source_snapshot_id)
);

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

CREATE UNIQUE INDEX source_observation_set_snapshot_identity
ON source_observation_sets (id, source_snapshot_id);

CREATE TABLE reconciliation_candidates (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  source_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  printing_id TEXT,
  source_lineage TEXT NOT NULL,
  locator TEXT,
  variant_key TEXT,
  compatibility_json TEXT,
  memberships_json TEXT NOT NULL,
  withdrawal_json TEXT,
  warnings_json TEXT NOT NULL,
  digest_payload_json TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, source_observation_id),
  UNIQUE (source_observation_set_id, source_observation_id),
  FOREIGN KEY (source_observation_set_id, source_snapshot_id)
    REFERENCES source_observation_sets (id, source_snapshot_id)
);

CREATE TABLE reconciliation_contexts (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  source_observation_set_id TEXT NOT NULL REFERENCES source_observation_sets(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_lineage TEXT NOT NULL,
  digest_payload_json TEXT NOT NULL,
  FOREIGN KEY (source_observation_set_id, source_snapshot_id)
    REFERENCES source_observation_sets (id, source_snapshot_id)
);

CREATE TABLE reconciliation_evidence_partitions (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  sequence_number INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  source_observation_set_id TEXT NOT NULL REFERENCES source_observation_sets(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, sequence_number),
  UNIQUE (ingestion_run_id, request_id),
  UNIQUE (source_observation_set_id),
  FOREIGN KEY (source_observation_set_id, source_snapshot_id)
    REFERENCES source_observation_sets (id, source_snapshot_id)
);

CREATE TABLE reconciliation_payload_chunks (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  payload_kind TEXT NOT NULL CHECK (
    payload_kind IN ('candidate', 'digest')
  ),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 524288),
  PRIMARY KEY (ingestion_run_id, payload_kind, chunk_index)
);

CREATE TRIGGER reconciliation_contexts_are_immutable_on_update
BEFORE UPDATE ON reconciliation_contexts
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_context_immutable');
END;

CREATE TRIGGER reconciliation_contexts_are_immutable_on_delete
BEFORE DELETE ON reconciliation_contexts
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_context_immutable');
END;

CREATE TRIGGER reconciliation_candidates_are_immutable_on_update
BEFORE UPDATE ON reconciliation_candidates
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_candidate_immutable');
END;

CREATE TRIGGER reconciliation_candidates_are_immutable_on_delete
BEFORE DELETE ON reconciliation_candidates
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_candidate_immutable');
END;

CREATE TRIGGER reconciliation_evidence_partitions_are_immutable_on_update
BEFORE UPDATE ON reconciliation_evidence_partitions
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_evidence_partition_immutable');
END;

CREATE TRIGGER reconciliation_evidence_partitions_are_immutable_on_delete
BEFORE DELETE ON reconciliation_evidence_partitions
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_evidence_partition_immutable');
END;

CREATE TRIGGER reconciliation_payload_chunks_are_immutable_on_update
BEFORE UPDATE ON reconciliation_payload_chunks
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_payload_chunk_immutable');
END;

CREATE TRIGGER reconciliation_payload_chunks_are_immutable_on_delete
BEFORE DELETE ON reconciliation_payload_chunks
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_payload_chunk_immutable');
END;

CREATE TRIGGER reconciled_card_identity_is_immutable
BEFORE UPDATE OF
  id,
  supported_game,
  official_identity_kind,
  official_identity_value,
  first_revision_id
ON reconciled_cards
BEGIN
  SELECT RAISE(ABORT, 'reconciled_card_identity_immutable');
END;

CREATE TRIGGER reconciled_printing_identity_is_immutable
BEFORE UPDATE OF
  id,
  card_id,
  source_lineage,
  artwork_fingerprint,
  printed_fields_digest,
  rarity_normalized,
  treatment,
  first_revision_id
ON reconciled_printings
BEGIN
  SELECT RAISE(ABORT, 'reconciled_printing_identity_immutable');
END;
