-- 2026-08-07 production feedback (#55): every lineage re-registers with a
-- live product-detail parser that reads the current publisher product pages,
-- promotes only card-associated publications to Products, and retains
-- accessory pages as explicit non-card evidence. Earlier identities remain
-- installed for retained replay.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'one-piece-en@5',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'one-piece-en-restructured-complete-catalogue@5',
    'production'
  ),
  (
    'fusion-world-en@6',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'fusion-world-en-restructured-complete-catalogue@5',
    'production'
  ),
  (
    'digimon-en@6',
    'digimon-en',
    'digimon',
    'digimon@1',
    'digimon-en-restructured-complete-catalogue@5',
    'production'
  ),
  (
    'gundam-en-asia@6',
    'gundam-en-asia',
    'gundam',
    'gundam@1',
    'gundam-en-asia-restructured-complete-catalogue@5',
    'production'
  ),
  (
    'gundam-en-us@6',
    'gundam-en-us',
    'gundam',
    'gundam@1',
    'gundam-en-us-restructured-complete-catalogue@5',
    'production'
  );

UPDATE catalogue_schema_state
SET migration_level = 23
WHERE singleton = 1 AND migration_level = 22;
