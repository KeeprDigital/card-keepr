-- #333: before Go-Live, extend the Riftbound DB registration to its set-census
-- envelope after its collection is quiescent (ADR 0008). The capacity covers
-- the facets root, pages of 80 across the 11 retained set buckets and one
-- original front per record hosted off Riot's CDN, with headroom. It is not a
-- measured inventory or throughput and designates no Source Authority.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=50
THEN 1 ELSE json_extract('schema_level_mismatch_expected_50','$') END;

SELECT CASE WHEN (SELECT COUNT(*) FROM source_adapter_versions
 WHERE adapter_version='riftbound-db-en@1'
 AND source_lineage='riftbound-db-en' AND supported_game='riftbound'
 AND game_profile_version='riftbound@1'
 AND parser_contract='riftbound-db-bounded-queries@1'
 AND adapter_origin='production' AND request_capacity=7)=1
THEN 1 ELSE json_extract('riftbound_db_registration_predecessor_mismatch','$') END;

-- Same quiescence rule as 0043: no resumable or unfinished collection may use
-- this exact version while its capacity changes. Retained history is unchanged.
SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM ingestion_evidence_plans plans
 LEFT JOIN ingestion_run_current current ON current.ingestion_run_id=plans.ingestion_run_id
 LEFT JOIN ingestion_run_events latest ON latest.ingestion_run_id=plans.ingestion_run_id
  AND latest.sequence_number=(SELECT MAX(event.sequence_number) FROM ingestion_run_events event
    WHERE event.ingestion_run_id=plans.ingestion_run_id)
 WHERE (plans.adapter_version='riftbound-db-en@1'
  OR json_extract(plans.request_plan_json,'$.adapter_version')='riftbound-db-en@1'
  OR EXISTS(SELECT 1 FROM json_each(plans.request_plan_json,'$.plans') plan
    WHERE json_extract(plan.value,'$.adapter_version')='riftbound-db-en@1'))
 AND NOT EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications restored
  WHERE restored.ingestion_run_id=plans.ingestion_run_id
   AND restored.classification='abandoned_after_restore')
 AND (current.ingestion_run_id IS NULL OR latest.ingestion_run_id IS NULL
  OR current.state IS NOT latest.to_state
  OR current.state IN ('planning','collecting','paused')
  OR (plans.collection_completed_at IS NULL
    AND current.state NOT IN ('published','rejected','expired','failed')))
) THEN 1 ELSE json_extract('riftbound_db_collection_must_be_quiescent','$') END;

DROP TRIGGER source_adapter_version_is_immutable;

UPDATE source_adapter_versions SET request_capacity=2500
 WHERE adapter_version='riftbound-db-en@1'
 AND source_lineage='riftbound-db-en' AND supported_game='riftbound'
 AND game_profile_version='riftbound@1'
 AND parser_contract='riftbound-db-bounded-queries@1'
 AND adapter_origin='production' AND request_capacity=7;
SELECT CASE WHEN changes()=1
THEN 1 ELSE json_extract('riftbound_db_registration_update_count_mismatch','$') END;

CREATE TRIGGER source_adapter_version_is_immutable
BEFORE UPDATE ON source_adapter_versions
BEGIN
  SELECT RAISE(ABORT, 'source_adapter_version_immutable');
END;

UPDATE catalogue_schema_state SET migration_level=51
 WHERE singleton=1 AND migration_level=50;
SELECT CASE WHEN changes()=1
THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
