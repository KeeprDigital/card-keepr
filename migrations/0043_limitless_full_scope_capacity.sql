-- Before Go-Live, extend the existing Limitless registration after collection is quiescent.
-- Apply atomically through ordinary migrations; retain every identity and history row.
-- The capacity is the dated census envelope of the retained 2026-09-21 Products/Promos
-- bucket bodies (issue #334): two index roots, 143 buckets, every unique grid detail
-- page and every unique referenced front image. It is not measured throughput.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=42
THEN 1 ELSE json_extract('schema_level_mismatch_expected_predecessor','$') END;

SELECT CASE WHEN (SELECT COUNT(*) FROM source_adapter_versions
 WHERE adapter_version='limitless-one-piece-en@1'
 AND source_lineage='limitless-one-piece-en' AND supported_game='one-piece'
 AND game_profile_version='one-piece@1'
 AND parser_contract='limitless-one-piece-p001-html@1'
 AND adapter_origin='production' AND request_capacity=100)=1
THEN 1 ELSE json_extract('limitless_registration_predecessor_mismatch','$') END;

-- Generation 1 uses current registration. Reservation absence alone is not
-- terminality: native completion and permanent restore abandonment remove it.
-- Inspect every exact old single/composed plan, its state projection and latest
-- immutable event for state agreement, not complete projection integrity.
-- Do not change state, reservations or retained history.
SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM ingestion_evidence_plans plans
 LEFT JOIN ingestion_run_current current ON current.ingestion_run_id=plans.ingestion_run_id
 LEFT JOIN ingestion_run_events latest ON latest.ingestion_run_id=plans.ingestion_run_id
  AND latest.sequence_number=(SELECT MAX(event.sequence_number) FROM ingestion_run_events event
    WHERE event.ingestion_run_id=plans.ingestion_run_id)
 WHERE (plans.adapter_version='limitless-one-piece-en@1'
  OR json_extract(plans.request_plan_json,'$.adapter_version')='limitless-one-piece-en@1'
  OR EXISTS(SELECT 1 FROM json_each(plans.request_plan_json,'$.plans') plan
    WHERE json_extract(plan.value,'$.adapter_version')='limitless-one-piece-en@1'))
 AND NOT EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications restored
  WHERE restored.ingestion_run_id=plans.ingestion_run_id
   AND restored.classification='abandoned_after_restore')
 AND (current.ingestion_run_id IS NULL OR latest.ingestion_run_id IS NULL
  OR current.state IS NOT latest.to_state
  OR current.state IN ('planning','collecting','paused')
  OR (plans.collection_completed_at IS NULL
    AND current.state NOT IN ('published','rejected','expired','failed')))
) THEN 1 ELSE json_extract('limitless_collection_must_be_quiescent','$') END;

DROP TRIGGER source_adapter_version_is_immutable;

UPDATE source_adapter_versions SET request_capacity=9559
 WHERE adapter_version='limitless-one-piece-en@1'
 AND source_lineage='limitless-one-piece-en' AND supported_game='one-piece'
 AND game_profile_version='one-piece@1'
 AND parser_contract='limitless-one-piece-p001-html@1'
 AND adapter_origin='production' AND request_capacity=100;
SELECT CASE WHEN changes()=1
THEN 1 ELSE json_extract('limitless_registration_update_count_mismatch','$') END;

CREATE TRIGGER source_adapter_version_is_immutable
BEFORE UPDATE ON source_adapter_versions
BEGIN
  SELECT RAISE(ABORT, 'source_adapter_version_immutable');
END;

UPDATE catalogue_schema_state SET migration_level=43
 WHERE singleton=1 AND migration_level=42;
SELECT CASE WHEN changes()=1
THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
