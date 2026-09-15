-- #331: supplementary Riftbound DB pilot; no Source Authority designation.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=40
THEN 1 ELSE json_extract('schema_level_mismatch_expected_40','$') END;

INSERT INTO source_adapter_versions
  (adapter_version,source_lineage,supported_game,game_profile_version,parser_contract,adapter_origin,request_capacity)
VALUES ('riftbound-db-en@1','riftbound-db-en','riftbound','riftbound@1','riftbound-db-bounded-queries@1','production',7);

UPDATE catalogue_schema_state SET migration_level=41 WHERE singleton=1 AND migration_level=40;
SELECT CASE WHEN changes()=1
THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
