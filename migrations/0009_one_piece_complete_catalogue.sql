-- Complete One Piece catalogue capture is a new immutable parser contract.
-- one-piece-en@2 remains available only for retained-snapshot reprocessing.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES (
  'one-piece-en@3',
  'one-piece-en',
  'one-piece',
  'one-piece@1',
  'one-piece-en-complete-catalogue@3',
  'production'
);
