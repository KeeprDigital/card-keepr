-- Issue #69: a synthetic Source Adapter Version whose immutable request
-- capacity exceeds the historical 5,000-request bound, so the stress suite
-- can prove that one Source Lineage larger than that bound completes
-- collection through bounded hostname Workflow shards without touching an
-- Official Source. It parses the same synthetic fixture card documents as
-- fixture-fusion-world-json@1 and differs only in its capacity. This seed
-- remains a database constraint copy of installedSourceAdapterRegistrations;
-- the Worker drift test requires exact agreement, request_capacity included.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin,
  request_capacity
) VALUES
  (
    'fixture-fusion-world-json-large@1',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'synthetic-fixture-card-document@1',
    'synthetic_fixture',
    15000
  );

UPDATE catalogue_schema_state
SET migration_level = 33
WHERE singleton = 1 AND migration_level = 32;
