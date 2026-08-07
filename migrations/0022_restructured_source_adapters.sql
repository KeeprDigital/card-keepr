-- 2026-08 Bandai site restructure: every lineage re-registers a new Source
-- Adapter Version pinned to the live URL shapes verified on 2026-08-06/07.
-- Earlier identities remain installed for retained replay.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'one-piece-en@4',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'one-piece-en-restructured-complete-catalogue@4',
    'production'
  ),
  (
    'fusion-world-en@5',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'fusion-world-en-restructured-complete-catalogue@4',
    'production'
  ),
  (
    'digimon-en@5',
    'digimon-en',
    'digimon',
    'digimon@1',
    'digimon-en-restructured-complete-catalogue@4',
    'production'
  ),
  (
    'gundam-en-asia@5',
    'gundam-en-asia',
    'gundam',
    'gundam@1',
    'gundam-en-asia-restructured-complete-catalogue@4',
    'production'
  ),
  (
    'gundam-en-us@5',
    'gundam-en-us',
    'gundam',
    'gundam@1',
    'gundam-en-us-restructured-complete-catalogue@4',
    'production'
  );

UPDATE catalogue_schema_state
SET migration_level = 22
WHERE singleton = 1 AND migration_level = 21;
