PRAGMA foreign_keys = ON;

INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'one-piece-json-document@3',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'one-piece-official-surfaces@3',
    'production'
  ),
  (
    'fusion-world-en@2',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'fusion-world-official-surfaces@3',
    'production'
  ),
  (
    'digimon-en@2',
    'digimon-en',
    'digimon',
    'digimon@1',
    'digimon-official-surfaces@3',
    'production'
  ),
  (
    'gundam-en-asia@2',
    'gundam-en-asia',
    'gundam',
    'gundam@1',
    'gundam-official-surfaces@3',
    'production'
  ),
  (
    'gundam-en-us@2',
    'gundam-en-us',
    'gundam',
    'gundam@1',
    'gundam-official-surfaces@3',
    'production'
  );

CREATE TABLE legality_rules (
  id TEXT PRIMARY KEY,
  official_id TEXT NOT NULL,
  supported_game TEXT NOT NULL CHECK (
    supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  region TEXT NOT NULL CHECK (
    region IN ('EN-OCEANIA', 'EN-ASIA', 'EN-US')
  ),
  format TEXT NOT NULL CHECK (length(format) > 0),
  event_tier TEXT CHECK (event_tier IS NULL OR length(event_tier) > 0),
  effective_from TEXT NOT NULL,
  effective_until TEXT CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  official_wording TEXT NOT NULL CHECK (length(official_wording) > 0),
  effect_json TEXT NOT NULL CHECK (
    json_valid(effect_json) AND json_type(effect_json) = 'object'
  ),
  card_ids_json TEXT NOT NULL CHECK (
    json_valid(card_ids_json) AND json_type(card_ids_json) = 'array'
  ),
  source_lineage TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  source_observation_id TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  UNIQUE (source_lineage, official_id)
);

CREATE INDEX legality_rules_context
  ON legality_rules (
    supported_game,
    region,
    format,
    event_tier,
    effective_from,
    effective_until
  );

CREATE TRIGGER guard_legality_rule_identity
BEFORE UPDATE ON legality_rules
WHEN OLD.supported_game <> NEW.supported_game
  OR OLD.official_id <> NEW.official_id
  OR OLD.region <> NEW.region
  OR OLD.format <> NEW.format
  OR COALESCE(OLD.event_tier, '') <> COALESCE(NEW.event_tier, '')
  OR OLD.effective_from <> NEW.effective_from
  OR COALESCE(OLD.effective_until, '') <> COALESCE(NEW.effective_until, '')
  OR OLD.official_wording <> NEW.official_wording
  OR OLD.effect_json <> NEW.effect_json
  OR OLD.card_ids_json <> NEW.card_ids_json
  OR OLD.source_lineage <> NEW.source_lineage
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_identity_conflict');
END;

CREATE TABLE revision_legality_rules (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  legality_rule_id TEXT NOT NULL,
  supported_game TEXT NOT NULL CHECK (
    supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  region TEXT NOT NULL CHECK (
    region IN ('EN-OCEANIA', 'EN-ASIA', 'EN-US')
  ),
  format TEXT NOT NULL CHECK (length(format) > 0),
  event_tier TEXT CHECK (event_tier IS NULL OR length(event_tier) > 0),
  effective_from TEXT NOT NULL,
  effective_until TEXT CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  card_ids_json TEXT NOT NULL CHECK (
    json_valid(card_ids_json) AND json_type(card_ids_json) = 'array'
  ),
  document_json TEXT NOT NULL CHECK (
    json_valid(document_json) AND json_type(document_json) = 'object'
  ),
  PRIMARY KEY (catalogue_revision_id, legality_rule_id)
);

CREATE INDEX revision_legality_rules_context
  ON revision_legality_rules (
    catalogue_revision_id,
    region,
    format,
    event_tier,
    effective_from,
    effective_until
  );
