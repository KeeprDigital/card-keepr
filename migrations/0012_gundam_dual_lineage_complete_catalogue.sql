-- Complete Gundam collection is versioned independently for each publisher
-- locale. Earlier @2 and @3 identities remain installed for retained replay.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'gundam-en-asia@4',
    'gundam-en-asia',
    'gundam',
    'gundam@1',
    'gundam-en-asia-raw-surfaces-complete-catalogue@3',
    'production'
  ),
  (
    'gundam-en-us@4',
    'gundam-en-us',
    'gundam',
    'gundam@1',
    'gundam-en-us-raw-surfaces-complete-catalogue@3',
    'production'
  );
