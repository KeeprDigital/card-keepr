-- #332: supplementary HexDeck pilot; no Source Authority designation.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=44
THEN 1 ELSE json_extract('schema_level_mismatch_expected_44','$') END;

INSERT INTO source_adapter_versions
  (adapter_version,source_lineage,supported_game,game_profile_version,parser_contract,adapter_origin,request_capacity)
VALUES ('hexdeck-en@1','hexdeck-en','riftbound','riftbound@1','hexdeck-search-flight@1','production',4);

UPDATE catalogue_schema_state SET migration_level=45 WHERE singleton=1 AND migration_level=44;
SELECT CASE WHEN changes()=1
THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
