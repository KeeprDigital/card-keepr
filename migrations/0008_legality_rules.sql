PRAGMA foreign_keys = ON;

INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES (
  'fixture-one-piece-json@2',
  'one-piece-en',
  'one-piece',
  'one-piece@1',
  'synthetic-fixture-card-document@1',
  'synthetic_fixture'
);

CREATE TABLE official_source_collection_plans (
  ingestion_run_id TEXT PRIMARY KEY
    REFERENCES ingestion_evidence_plans(ingestion_run_id),
  discovery_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  contract TEXT NOT NULL
    CHECK (contract = 'card-keepr-official-source-collection-plan@1'),
  collection_plan_json TEXT NOT NULL CHECK (json_valid(collection_plan_json)),
  content_digest TEXT NOT NULL
    CHECK (length(content_digest) = 64 AND content_digest GLOB '[0-9a-f]*'),
  created_at TEXT NOT NULL
);

CREATE TRIGGER official_source_collection_plan_discovery_owner
BEFORE INSERT ON official_source_collection_plans
WHEN NOT EXISTS (
  SELECT 1
  FROM source_observation_sets AS observation_set
  JOIN source_snapshots AS snapshot
    ON snapshot.id = observation_set.source_snapshot_id
  WHERE observation_set.id = NEW.discovery_observation_set_id
    AND snapshot.ingestion_run_id = NEW.ingestion_run_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'official_source_collection_plan_discovery_owner_mismatch'
  );
END;

CREATE TRIGGER official_source_collection_plans_immutable_update
BEFORE UPDATE ON official_source_collection_plans
BEGIN
  SELECT RAISE(ABORT, 'official_source_collection_plan_immutable');
END;

CREATE TRIGGER ingestion_evidence_plan_request_set_immutable
BEFORE UPDATE OF ingestion_run_id, source_lineage, supported_game,
  game_profile_version, adapter_version, request_plan_json, plan_origin
ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'ingestion_evidence_plan_request_set_immutable');
END;

CREATE TRIGGER ingestion_evidence_plans_immutable_delete
BEFORE DELETE ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'ingestion_evidence_plan_immutable');
END;

CREATE TRIGGER official_source_collection_plans_immutable_delete
BEFORE DELETE ON official_source_collection_plans
BEGIN
  SELECT RAISE(ABORT, 'official_source_collection_plan_immutable');
END;

CREATE TRIGGER source_requests_plan_fields_immutable
BEFORE UPDATE OF ingestion_run_id, request_id, sequence_number, method,
  url, request_headers_json, representation_fingerprint
ON source_requests
BEGIN
  SELECT RAISE(ABORT, 'source_request_plan_fields_immutable');
END;

CREATE TRIGGER source_requests_must_match_immutable_plan
BEFORE INSERT ON source_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_evidence_plans AS plan,
       json_each(plan.request_plan_json, '$.requests') AS planned
  WHERE plan.ingestion_run_id = NEW.ingestion_run_id
    AND json_extract(planned.value, '$.id') = NEW.request_id
    AND CAST(planned.key AS INTEGER) = NEW.sequence_number
    AND json_extract(planned.value, '$.method') = NEW.method
    AND json_extract(planned.value, '$.url') = NEW.url
    AND json_extract(planned.value, '$.headers') = NEW.request_headers_json
    AND json_extract(planned.value, '$.representation_fingerprint') =
      NEW.representation_fingerprint
)
AND NOT EXISTS (
  SELECT 1
  FROM ingestion_evidence_plans AS plan
  JOIN official_source_collection_plans AS collection
    ON collection.ingestion_run_id = plan.ingestion_run_id,
       json_each(collection.collection_plan_json, '$.requests') AS planned
  WHERE plan.ingestion_run_id = NEW.ingestion_run_id
    AND json_extract(planned.value, '$.id') = NEW.request_id
    AND json_array_length(
      json_extract(plan.request_plan_json, '$.requests')
    ) + CAST(planned.key AS INTEGER) = NEW.sequence_number
    AND json_extract(planned.value, '$.method') = NEW.method
    AND json_extract(planned.value, '$.url') = NEW.url
    AND json_extract(planned.value, '$.headers') = NEW.request_headers_json
    AND json_extract(planned.value, '$.representation_fingerprint') =
      NEW.representation_fingerprint
    AND json_type(planned.value, '$.surface') = 'text'
    AND length(json_extract(planned.value, '$.surface')) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'source_request_not_in_immutable_plan');
END;

CREATE TRIGGER source_requests_immutable_delete
BEFORE DELETE ON source_requests
BEGIN
  SELECT RAISE(ABORT, 'source_request_immutable');
END;

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
  source_observation_pointer TEXT NOT NULL CHECK (
    source_observation_pointer LIKE '/observations/%'
  ),
  source_field_pointers_json TEXT NOT NULL CHECK (
    json_valid(source_field_pointers_json)
    AND json_type(source_field_pointers_json) = 'object'
  ),
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
