PRAGMA foreign_keys = ON;

CREATE TABLE reconciled_cards (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  official_identity_kind TEXT NOT NULL,
  official_identity_value TEXT NOT NULL,
  first_revision_id TEXT NOT NULL,
  last_observed_revision_id TEXT NOT NULL,
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawn_revision_id TEXT,
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
  printed_rules_fingerprint TEXT NOT NULL,
  rarity_raw TEXT NOT NULL,
  rarity_normalized TEXT NOT NULL,
  treatment TEXT NOT NULL,
  memberships_json TEXT NOT NULL,
  first_revision_id TEXT NOT NULL,
  last_observed_revision_id TEXT NOT NULL,
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawn_revision_id TEXT,
  withdrawal_evidence_json TEXT
);

CREATE INDEX reconciled_printing_candidates
ON reconciled_printings (
  card_id,
  source_lineage,
  artwork_fingerprint,
  printed_rules_fingerprint,
  rarity_raw,
  rarity_normalized,
  treatment
);

CREATE TABLE reconciled_printing_locators (
  printing_id TEXT NOT NULL REFERENCES reconciled_printings(id),
  source_lineage TEXT NOT NULL,
  locator TEXT NOT NULL,
  first_observed_revision_id TEXT NOT NULL,
  last_observed_revision_id TEXT NOT NULL,
  PRIMARY KEY (source_lineage, locator),
  UNIQUE (printing_id, source_lineage, locator)
);

CREATE TABLE reconciliation_source_observations (
  source_observation_id TEXT PRIMARY KEY,
  catalogue_revision_id TEXT NOT NULL,
  printing_id TEXT NOT NULL REFERENCES reconciled_printings(id),
  observation_json TEXT NOT NULL,
  unknown_fields_json TEXT NOT NULL
);

CREATE TRIGGER reconciled_printing_locator_conflicts_fail_closed
BEFORE INSERT ON reconciled_printing_locators
WHEN EXISTS (
  SELECT 1
  FROM reconciled_printing_locators AS existing
  WHERE existing.source_lineage = NEW.source_lineage
    AND existing.locator = NEW.locator
    AND existing.printing_id <> NEW.printing_id
)
BEGIN
  SELECT RAISE(ABORT, 'printing_locator_identity_conflict');
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
  printed_rules_fingerprint,
  rarity_raw,
  rarity_normalized,
  treatment,
  first_revision_id
ON reconciled_printings
BEGIN
  SELECT RAISE(ABORT, 'reconciled_printing_identity_immutable');
END;

CREATE TRIGGER reconciliation_source_observations_are_immutable_on_update
BEFORE UPDATE ON reconciliation_source_observations
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_source_observation_immutable');
END;

CREATE TRIGGER reconciliation_source_observations_are_immutable_on_delete
BEFORE DELETE ON reconciliation_source_observations
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_source_observation_immutable');
END;
