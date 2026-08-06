-- Digimon complete-leaf and Official Errata parsing is a new immutable
-- adapter contract. V3 remains installed for exact retained-snapshot reparses.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES (
  'digimon-en@4',
  'digimon-en',
  'digimon',
  'digimon@1',
  'digimon-en-raw-surfaces-complete-catalogue@3',
  'production'
);
