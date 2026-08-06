-- The complete Fusion World catalogue parser is a new immutable contract.
-- Earlier @2 and @3 identities remain installed solely for retained reparse.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES (
  'fusion-world-en@4',
  'fusion-world-en',
  'fusion-world',
  'fusion-world@1',
  'fusion-world-en-raw-surfaces-with-legality-and-catalogue@3',
  'production'
);
