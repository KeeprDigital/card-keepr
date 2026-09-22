-- #330: before Go-Live, extend the Piltover Archive registration to its gallery
-- census envelope after its collection is quiescent (ADR 0008). The capacity is
-- the retained 2026-09-21 page 1's 26 pages and 1,240 displayed rows, each with
-- at most one front, plus about 10% growth headroom. It is not measured
-- throughput and designates no Source Authority.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=46
THEN 1 ELSE json_extract('schema_level_mismatch_expected_46','$') END;

SELECT CASE WHEN (SELECT COUNT(*) FROM source_adapter_versions
 WHERE adapter_version='piltover-archive-en@1'
 AND source_lineage='piltover-archive-en' AND supported_game='riftbound'
 AND game_profile_version='riftbound@1'
 AND parser_contract='piltover-archive-gallery-flight@1'
 AND adapter_origin='production' AND request_capacity=3)=1
THEN 1 ELSE json_extract('piltover_archive_registration_predecessor_mismatch','$') END;

-- Same quiescence rule as 0043: no resumable or unfinished collection may use
-- this exact version while its capacity changes. Retained history is unchanged.
SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM ingestion_evidence_plans plans
 LEFT JOIN ingestion_run_current current ON current.ingestion_run_id=plans.ingestion_run_id
 LEFT JOIN ingestion_run_events latest ON latest.ingestion_run_id=plans.ingestion_run_id
  AND latest.sequence_number=(SELECT MAX(event.sequence_number) FROM ingestion_run_events event
    WHERE event.ingestion_run_id=plans.ingestion_run_id)
 WHERE (plans.adapter_version='piltover-archive-en@1'
  OR json_extract(plans.request_plan_json,'$.adapter_version')='piltover-archive-en@1'
  OR EXISTS(SELECT 1 FROM json_each(plans.request_plan_json,'$.plans') plan
    WHERE json_extract(plan.value,'$.adapter_version')='piltover-archive-en@1'))
 AND NOT EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications restored
  WHERE restored.ingestion_run_id=plans.ingestion_run_id
   AND restored.classification='abandoned_after_restore')
 AND (current.ingestion_run_id IS NULL OR latest.ingestion_run_id IS NULL
  OR current.state IS NOT latest.to_state
  OR current.state IN ('planning','collecting','paused')
  OR (plans.collection_completed_at IS NULL
    AND current.state NOT IN ('published','rejected','expired','failed')))
) THEN 1 ELSE json_extract('piltover_archive_collection_must_be_quiescent','$') END;

DROP TRIGGER source_adapter_version_is_immutable;

UPDATE source_adapter_versions SET request_capacity=1400
 WHERE adapter_version='piltover-archive-en@1'
 AND source_lineage='piltover-archive-en' AND supported_game='riftbound'
 AND game_profile_version='riftbound@1'
 AND parser_contract='piltover-archive-gallery-flight@1'
 AND adapter_origin='production' AND request_capacity=3;
SELECT CASE WHEN changes()=1
THEN 1 ELSE json_extract('piltover_archive_registration_update_count_mismatch','$') END;

CREATE TRIGGER source_adapter_version_is_immutable
BEFORE UPDATE ON source_adapter_versions
BEGIN
  SELECT RAISE(ABORT, 'source_adapter_version_immutable');
END;

UPDATE catalogue_schema_state SET migration_level=47
 WHERE singleton=1 AND migration_level=46;
SELECT CASE WHEN changes()=1
THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
