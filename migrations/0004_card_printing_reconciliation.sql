PRAGMA foreign_keys = ON;

ALTER TABLE source_adapter_versions
ADD COLUMN adapter_origin TEXT NOT NULL DEFAULT 'production'
CHECK (adapter_origin IN ('production', 'synthetic_fixture'));

ALTER TABLE ingestion_evidence_plans
ADD COLUMN plan_origin TEXT NOT NULL DEFAULT 'production'
CHECK (plan_origin IN ('production', 'synthetic_fixture'));

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
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  PRIMARY KEY (source_lineage, locator)
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
  PRIMARY KEY (card_id, source_lineage, source_observation_id)
);

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
