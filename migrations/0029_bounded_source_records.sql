-- Bounded record intake: raw evidence stays in R2; immutable records belong to a parse intent.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=28 THEN 1 ELSE json_extract('schema_level_mismatch_expected_28','$') END;
CREATE TABLE source_record_pages (
  observation_set_id TEXT NOT NULL REFERENCES source_parse_operations(observation_set_id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  source_key TEXT NOT NULL,
  content TEXT NOT NULL CHECK(length(CAST(content AS BLOB)) <= 512000),
  sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB)) <= 4096),
  PRIMARY KEY(observation_set_id, ordinal),
  UNIQUE(observation_set_id, source_key)
);
CREATE TABLE source_record_progress (
  observation_set_id TEXT PRIMARY KEY REFERENCES source_parse_operations(observation_set_id),
  next_ordinal INTEGER NOT NULL CHECK(next_ordinal >= 0),
  digest TEXT NOT NULL,
  header_json TEXT NOT NULL CHECK(length(CAST(header_json AS BLOB)) <= 32768),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1))
);
CREATE TRIGGER source_records_immutable BEFORE UPDATE ON source_record_pages
BEGIN SELECT RAISE(ABORT,'immutable_source_record'); END;
CREATE TRIGGER source_records_cleanup_fence BEFORE INSERT ON source_record_pages
WHEN EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_snapshot_keys k ON k.snapshot_id=p.source_snapshot_id
 JOIN evidence_cleanup_objects deleted ON deleted.object_key=k.object_key WHERE p.observation_set_id=NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;


CREATE TRIGGER source_records_sealed_insert BEFORE INSERT ON source_record_pages
WHEN EXISTS(SELECT 1 FROM source_record_progress WHERE observation_set_id=NEW.observation_set_id AND sealed=1)
 AND NOT EXISTS(SELECT 1 FROM source_record_pages WHERE observation_set_id=NEW.observation_set_id AND ordinal=NEW.ordinal
 AND source_key=NEW.source_key AND content=NEW.content AND sha256=NEW.sha256 AND request_json=NEW.request_json)
BEGIN SELECT RAISE(ABORT,'source_records_already_sealed'); END;
CREATE TRIGGER source_records_progress_immutable BEFORE UPDATE ON source_record_progress
WHEN NEW.observation_set_id!=OLD.observation_set_id OR NEW.header_json!=OLD.header_json
 OR NEW.next_ordinal<OLD.next_ordinal OR (OLD.sealed=1 AND (NEW.sealed!=1 OR NEW.next_ordinal!=OLD.next_ordinal OR NEW.digest!=OLD.digest))
BEGIN SELECT RAISE(ABORT,'immutable_source_record_progress'); END;
CREATE TRIGGER source_records_seal_authority BEFORE UPDATE OF sealed ON source_record_progress
WHEN NEW.sealed=1 AND NOT EXISTS(SELECT 1 FROM source_observation_sets WHERE id=NEW.observation_set_id AND observation_count=NEW.next_ordinal)
BEGIN SELECT RAISE(ABORT,'source_records_missing_authority'); END;
CREATE TRIGGER recovery_fence_source_record_pages_insert BEFORE INSERT ON source_record_pages
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_pages_insert BEFORE INSERT ON source_record_pages
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_pages_insert BEFORE INSERT ON source_record_pages
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=NEW.observation_set_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_source_record_pages_update BEFORE UPDATE ON source_record_pages
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_pages_update BEFORE UPDATE ON source_record_pages
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_pages_update BEFORE UPDATE ON source_record_pages
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=NEW.observation_set_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_source_record_pages_delete BEFORE DELETE ON source_record_pages
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_pages_delete BEFORE DELETE ON source_record_pages
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_pages_delete BEFORE DELETE ON source_record_pages
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=OLD.observation_set_id) AND classification='abandoned_after_restore')
 AND NOT EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_objects d ON d.object_key=p.content_object_key WHERE p.observation_set_id=OLD.observation_set_id AND d.state='deleting')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_source_record_progress_insert BEFORE INSERT ON source_record_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_progress_insert BEFORE INSERT ON source_record_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_progress_insert BEFORE INSERT ON source_record_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=NEW.observation_set_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER source_record_progress_cleanup_insert BEFORE INSERT ON source_record_progress
WHEN EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_snapshot_keys k ON k.snapshot_id=p.source_snapshot_id JOIN evidence_cleanup_objects deleted ON deleted.object_key=k.object_key WHERE p.observation_set_id=NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER recovery_fence_source_record_progress_update BEFORE UPDATE ON source_record_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_progress_update BEFORE UPDATE ON source_record_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_progress_update BEFORE UPDATE ON source_record_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=NEW.observation_set_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER source_record_progress_cleanup_update BEFORE UPDATE ON source_record_progress
WHEN EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_snapshot_keys k ON k.snapshot_id=p.source_snapshot_id JOIN evidence_cleanup_objects deleted ON deleted.object_key=k.object_key WHERE p.observation_set_id=NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER recovery_fence_source_record_progress_delete BEFORE DELETE ON source_record_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_progress_delete BEFORE DELETE ON source_record_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_progress_delete BEFORE DELETE ON source_record_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=OLD.observation_set_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER source_records_immutable_delete BEFORE DELETE ON source_record_pages
WHEN NOT EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_objects d ON d.object_key=p.content_object_key
 WHERE p.observation_set_id=OLD.observation_set_id AND d.state='deleting')
BEGIN SELECT RAISE(ABORT,'immutable_source_record'); END;
CREATE TRIGGER source_records_progress_immutable_delete BEFORE DELETE ON source_record_progress
BEGIN SELECT RAISE(ABORT,'immutable_source_record_progress'); END;
-- A single indexed identity binds all page declarations in a run/lineage.
-- Returned record counts may remain below the declared publisher total.
CREATE TRIGGER source_records_pagination_identity BEFORE INSERT ON source_record_progress
WHEN EXISTS(
 SELECT 1 FROM source_parse_operations incoming_parse JOIN source_snapshots incoming ON incoming.id=incoming_parse.source_snapshot_id
 JOIN source_snapshots prior ON prior.ingestion_run_id=incoming.ingestion_run_id AND prior.source_lineage=incoming.source_lineage
 JOIN source_parse_operations prior_parse ON prior_parse.source_snapshot_id=prior.id
 JOIN source_record_progress progress ON progress.observation_set_id=prior_parse.observation_set_id
 WHERE incoming_parse.observation_set_id=NEW.observation_set_id
 AND json_extract(progress.header_json,'$.pagination') IS NOT json_extract(NEW.header_json,'$.pagination')
)
BEGIN SELECT RAISE(ABORT,'source_pagination_changed'); END;
UPDATE catalogue_schema_state SET migration_level=29 WHERE singleton=1;
