-- Extend bounded intake with independently addressed requests, discovery facts and large text.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=29 THEN 1 ELSE json_extract('schema_level_mismatch_expected_29','$') END;
ALTER TABLE source_record_progress ADD COLUMN requests_next_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(requests_next_ordinal>=0);
ALTER TABLE source_record_progress ADD COLUMN requests_digest TEXT;
ALTER TABLE source_record_progress ADD COLUMN requests_complete INTEGER NOT NULL DEFAULT 1 CHECK(requests_complete IN (0,1));
ALTER TABLE source_record_progress ADD COLUMN manifest_digest TEXT;
CREATE TABLE source_record_auxiliary (
 observation_set_id TEXT NOT NULL REFERENCES source_parse_operations(observation_set_id),
 kind TEXT NOT NULL CHECK(kind IN ('request','text','discovery','manifest')),
 record_key TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 content TEXT NOT NULL CHECK(length(CAST(content AS BLOB))<=128000),
 sha256 TEXT NOT NULL,
 PRIMARY KEY(observation_set_id,kind,record_key,ordinal)
);
CREATE TRIGGER source_record_auxiliary_immutable_update BEFORE UPDATE ON source_record_auxiliary
BEGIN SELECT RAISE(ABORT,'immutable_source_record_auxiliary'); END;
CREATE TRIGGER source_record_auxiliary_immutable_delete BEFORE DELETE ON source_record_auxiliary
WHEN NOT EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_objects d ON d.object_key=p.content_object_key
 WHERE p.observation_set_id=OLD.observation_set_id AND d.state='deleting')
BEGIN SELECT RAISE(ABORT,'immutable_source_record_auxiliary'); END;
CREATE TRIGGER source_record_auxiliary_cleanup_fence BEFORE INSERT ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_snapshot_keys k ON k.snapshot_id=p.source_snapshot_id
 JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE p.observation_set_id=NEW.observation_set_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER source_record_auxiliary_sealed_insert BEFORE INSERT ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM source_record_progress WHERE observation_set_id=NEW.observation_set_id AND sealed=1)
 AND NOT (NEW.kind IN ('manifest','request') AND EXISTS(SELECT 1 FROM source_record_progress WHERE observation_set_id=NEW.observation_set_id AND manifest_digest IS NULL))
 AND NOT EXISTS(SELECT 1 FROM source_record_auxiliary WHERE observation_set_id=NEW.observation_set_id AND kind=NEW.kind
 AND record_key=NEW.record_key AND ordinal=NEW.ordinal AND content=NEW.content AND sha256=NEW.sha256)
BEGIN SELECT RAISE(ABORT,'source_records_already_sealed'); END;
CREATE TRIGGER source_record_requests_progress BEFORE UPDATE ON source_record_progress
WHEN NEW.requests_next_ordinal<OLD.requests_next_ordinal OR (OLD.sealed=1 AND OLD.manifest_digest IS NOT NULL AND
 (NEW.requests_next_ordinal!=OLD.requests_next_ordinal OR NEW.requests_digest IS NOT OLD.requests_digest OR NEW.requests_complete!=OLD.requests_complete))
 OR (NEW.sealed=1 AND NEW.requests_complete!=1)
BEGIN SELECT RAISE(ABORT,'immutable_source_request_progress'); END;
CREATE TRIGGER recovery_fence_source_record_auxiliary_insert BEFORE INSERT ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_auxiliary_insert BEFORE INSERT ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_auxiliary_insert BEFORE INSERT ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=NEW.observation_set_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_source_record_auxiliary_update BEFORE UPDATE ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_auxiliary_update BEFORE UPDATE ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_auxiliary_update BEFORE UPDATE ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=NEW.observation_set_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_source_record_auxiliary_delete BEFORE DELETE ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_record_auxiliary_delete BEFORE DELETE ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_record_auxiliary_delete BEFORE DELETE ON source_record_auxiliary
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.observation_set_id=OLD.observation_set_id) AND classification='abandoned_after_restore') AND NOT EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_objects d ON d.object_key=p.content_object_key WHERE p.observation_set_id=OLD.observation_set_id AND d.state='deleting')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
DROP TRIGGER source_records_pagination_identity;
CREATE TRIGGER source_records_pagination_identity BEFORE INSERT ON source_record_progress
WHEN json_type(NEW.header_json,'$.pagination')='object' AND EXISTS(
 SELECT 1 FROM source_parse_operations incoming_parse JOIN source_snapshots incoming ON incoming.id=incoming_parse.source_snapshot_id
 JOIN source_snapshots prior ON prior.ingestion_run_id=incoming.ingestion_run_id AND prior.source_lineage=incoming.source_lineage
 JOIN source_parse_operations prior_parse ON prior_parse.source_snapshot_id=prior.id
 JOIN source_record_progress progress ON progress.observation_set_id=prior_parse.observation_set_id
 WHERE incoming_parse.observation_set_id=NEW.observation_set_id
 AND json_type(progress.header_json,'$.pagination')='object' AND json_extract(progress.header_json,'$.pagination') IS NOT json_extract(NEW.header_json,'$.pagination')
)
BEGIN SELECT RAISE(ABORT,'source_pagination_changed'); END;
CREATE TRIGGER source_record_manifest_binding BEFORE UPDATE ON source_record_progress
WHEN (OLD.manifest_digest IS NOT NULL AND NEW.manifest_digest IS NOT OLD.manifest_digest)
 OR (NEW.manifest_digest IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_record_auxiliary WHERE observation_set_id=NEW.observation_set_id AND kind='manifest' AND record_key='' AND ordinal=0 AND sha256=NEW.manifest_digest))
 OR (NEW.sealed=1 AND NEW.manifest_digest IS NULL)
BEGIN SELECT RAISE(ABORT,'source_record_manifest_binding'); END;
UPDATE catalogue_schema_state SET migration_level=30 WHERE singleton=1;
