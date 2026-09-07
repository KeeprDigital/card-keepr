-- Isolated branch starts from verified schema 23. Reconcile predecessor guard
-- with the coordinator's sequential integration of reserved migration 0024.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 23
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_23', '$') END;
INSERT INTO source_adapter_versions (
  adapter_version, source_lineage, supported_game, game_profile_version, parser_contract, adapter_origin, request_capacity
) VALUES ('limitless-one-piece-en@1', 'limitless-one-piece-en', 'one-piece', 'one-piece@1', 'limitless-one-piece-p001-html@1', 'production', 100);
UPDATE catalogue_schema_state SET migration_level = 25 WHERE singleton = 1;
