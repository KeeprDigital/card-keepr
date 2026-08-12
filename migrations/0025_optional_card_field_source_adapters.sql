-- 2026-08-12 production feedback (#55): the live Fusion World Energy Marker
-- detail pages publish no rarity block, and the live Digimon Q&A answers
-- nest related-card lists with Appmon-grade digivolution vocabulary. These
-- versions model both shapes explicitly. Earlier identities remain installed
-- for retained replay.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'fusion-world-en@7',
    'fusion-world-en',
    'fusion-world',
    'fusion-world@1',
    'fusion-world-en-restructured-complete-catalogue@6',
    'production'
  ),
  (
    'digimon-en@7',
    'digimon-en',
    'digimon',
    'digimon@1',
    'digimon-en-restructured-complete-catalogue@6',
    'production'
  );

UPDATE catalogue_schema_state
SET migration_level = 25
WHERE singleton = 1 AND migration_level = 24;
