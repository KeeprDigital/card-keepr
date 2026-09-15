-- #321: retain cited historical source evidence independently of owner replay.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=36
THEN 1 ELSE json_extract('schema_level_mismatch_expected_36','$') END;

-- Preserve pre-fix acknowledged Curated dependencies in every lifecycle state.
-- History, receipts and existing cleanup tombstones are never rewritten.
DROP VIEW evidence_cleanup_retained_snapshots;
CREATE VIEW evidence_cleanup_retained_snapshots AS
 SELECT snapshot.id AS snapshot_id FROM source_snapshots snapshot WHERE
 EXISTS(SELECT 1 FROM source_capture_operations ref JOIN ingestion_run_read owner ON owner.id=ref.ingestion_run_id WHERE ref.reused_source_snapshot_id=snapshot.id AND owner.state NOT IN ('failed','rejected','expired'))
 OR EXISTS(SELECT 1 FROM reconciliation_evidence_partitions ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM reconciliation_candidates ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM canonical_source_mappings ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM canonical_identity_reviews ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM canonical_identity_review_runs ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM entity_proposal_source_evidence ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM reconciled_withdrawal_assertions ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM game_candidates ref WHERE ref.ingestion_run_id=snapshot.ingestion_run_id)
 OR EXISTS(SELECT 1 FROM catalogue_revisions ref WHERE ref.ingestion_run_id=snapshot.ingestion_run_id)
 OR EXISTS(SELECT 1 FROM reconciliation_operations ref WHERE ref.ingestion_run_id=snapshot.ingestion_run_id AND ref.state NOT IN ('failed','abandoned'))
 OR EXISTS(SELECT 1 FROM reconciliation_evidence_selection ref JOIN reconciliation_operations operation ON operation.id=ref.preparation_id WHERE json_extract(ref.content,'$.row.source_snapshot_id')=snapshot.id AND (operation.state NOT IN ('failed','abandoned') OR EXISTS(SELECT 1 FROM game_candidates candidate WHERE candidate.preparation_id=operation.id)))
 OR EXISTS(SELECT 1 FROM reconciliation_source_mappings ref JOIN reconciliation_operations operation ON operation.id=ref.preparation_id WHERE ref.source_snapshot_id=snapshot.id AND (operation.state NOT IN ('failed','abandoned') OR EXISTS(SELECT 1 FROM game_candidates candidate WHERE candidate.preparation_id=operation.id)))
 UNION SELECT observations.source_snapshot_id
 FROM curated_revisions revision, json_each(revision.proposal_json,'$.evidence') evidence
 JOIN source_observation_sets observations
   ON observations.id='srcobsset_' || substr(json_extract(evidence.value,'$.id'),8,64)
 WHERE json_extract(evidence.value,'$.kind')='source_observation';

UPDATE catalogue_schema_state SET migration_level=37 WHERE singleton=1;
