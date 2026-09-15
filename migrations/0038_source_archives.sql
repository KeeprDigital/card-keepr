-- #327: bounded source archives, retained record receipts and physical evidence closure.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=37
THEN 1 ELSE json_extract('schema_level_mismatch_expected_37','$') END;

CREATE TABLE source_archive_decodes (
  source_snapshot_id TEXT PRIMARY KEY REFERENCES source_snapshots(id),
  pin_json TEXT NOT NULL CHECK(json_valid(pin_json) AND length(CAST(pin_json AS BLOB)) <= 8192),
  next_block INTEGER NOT NULL CHECK(next_block BETWEEN 0 AND 512),
  next_record INTEGER NOT NULL CHECK(next_record BETWEEN 0 AND 150000),
  decoded_bytes INTEGER NOT NULL CHECK(decoded_bytes BETWEEN 0 AND 1073741824),
  digest TEXT NOT NULL CHECK(length(digest)=64),
  decoded_digest TEXT CHECK(decoded_digest IS NULL OR length(decoded_digest)=64),
  state TEXT NOT NULL CHECK(state IN ('decoding','decoded')),
  CHECK((state='decoding' AND decoded_digest IS NULL) OR (state='decoded' AND decoded_digest IS NOT NULL AND next_record>0))
);
CREATE TABLE source_archive_blocks (
  source_snapshot_id TEXT NOT NULL REFERENCES source_archive_decodes(source_snapshot_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 511),
  byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
  first_record INTEGER NOT NULL CHECK(first_record >= 0),
  record_count INTEGER NOT NULL CHECK(record_count BETWEEN 1 AND 1024),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 4194304),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('planned','retained')),
  PRIMARY KEY(source_snapshot_id,ordinal),
  UNIQUE(source_snapshot_id,byte_offset),
  UNIQUE(source_snapshot_id,first_record)
);
CREATE TABLE source_archive_parse_progress (
  observation_set_id TEXT PRIMARY KEY REFERENCES source_parse_operations(observation_set_id),
  next_block INTEGER NOT NULL DEFAULT 0 CHECK(next_block BETWEEN 0 AND 512),
  block_offset INTEGER NOT NULL DEFAULT 0 CHECK(block_offset BETWEEN 0 AND 4194304),
  next_record INTEGER NOT NULL DEFAULT 0 CHECK(next_record BETWEEN 0 AND 150000),
  next_variant INTEGER NOT NULL DEFAULT 0 CHECK(next_variant BETWEEN 0 AND 3),
  observation_count INTEGER NOT NULL DEFAULT 0 CHECK(observation_count BETWEEN 0 AND 450000),
  selected_records INTEGER NOT NULL DEFAULT 0 CHECK(selected_records BETWEEN 0 AND 150000),
  excluded_counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(excluded_counts_json) AND length(excluded_counts_json)<=1024),
  discovery_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(discovery_ordinal BETWEEN 0 AND 450000),
  discovery_digest TEXT CHECK(discovery_digest IS NULL OR length(discovery_digest)=64),
  state TEXT NOT NULL DEFAULT 'normalizing' CHECK(state IN ('normalizing','normalized','complete'))
);
CREATE TABLE source_archive_record_receipts (
  observation_set_id TEXT NOT NULL REFERENCES source_archive_parse_progress(observation_set_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 149999),
  source_key TEXT NOT NULL,
  block_ordinal INTEGER NOT NULL CHECK(block_ordinal BETWEEN 0 AND 511),
  block_offset INTEGER NOT NULL CHECK(block_offset BETWEEN 0 AND 4194303),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 131072),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  exclusion TEXT,
  PRIMARY KEY(observation_set_id,ordinal),
  UNIQUE(observation_set_id,source_key)
);
CREATE TRIGGER archive_decode_identity BEFORE UPDATE ON source_archive_decodes
WHEN NEW.source_snapshot_id!=OLD.source_snapshot_id OR NEW.pin_json!=OLD.pin_json
 OR NEW.next_block<OLD.next_block OR NEW.next_record<OLD.next_record OR NEW.decoded_bytes<OLD.decoded_bytes
 OR (OLD.state='decoded' AND (NEW.state!=OLD.state OR NEW.next_block!=OLD.next_block OR NEW.next_record!=OLD.next_record
  OR NEW.decoded_bytes!=OLD.decoded_bytes OR NEW.digest!=OLD.digest OR NEW.decoded_digest IS NOT OLD.decoded_digest))
BEGIN SELECT RAISE(ABORT,'immutable_archive_decode'); END;
CREATE TRIGGER archive_block_identity BEFORE UPDATE ON source_archive_blocks
WHEN NEW.source_snapshot_id!=OLD.source_snapshot_id OR NEW.ordinal!=OLD.ordinal OR NEW.byte_offset!=OLD.byte_offset
 OR NEW.first_record!=OLD.first_record OR NEW.record_count!=OLD.record_count OR NEW.byte_length!=OLD.byte_length
 OR NEW.sha256!=OLD.sha256 OR NEW.object_key!=OLD.object_key OR (OLD.state='retained' AND NEW.state!='retained')
BEGIN SELECT RAISE(ABORT,'immutable_archive_block'); END;
CREATE TRIGGER archive_block_contiguous BEFORE INSERT ON source_archive_blocks
WHEN NOT EXISTS(SELECT 1 FROM source_archive_decodes d WHERE d.source_snapshot_id=NEW.source_snapshot_id AND d.state='decoding'
 AND d.next_block=NEW.ordinal AND d.next_record=NEW.first_record AND d.decoded_bytes=NEW.byte_offset)
 AND NOT EXISTS(SELECT 1 FROM source_archive_blocks b WHERE b.source_snapshot_id=NEW.source_snapshot_id AND b.ordinal=NEW.ordinal
 AND b.byte_offset=NEW.byte_offset AND b.first_record=NEW.first_record AND b.record_count=NEW.record_count
 AND b.byte_length=NEW.byte_length AND b.sha256=NEW.sha256 AND b.object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'archive_block_not_contiguous'); END;
CREATE TRIGGER archive_decode_advance BEFORE UPDATE OF next_block ON source_archive_decodes
WHEN NEW.next_block!=OLD.next_block AND (NEW.next_block!=OLD.next_block+1 OR NOT EXISTS(
 SELECT 1 FROM source_archive_blocks b WHERE b.source_snapshot_id=NEW.source_snapshot_id AND b.ordinal=OLD.next_block AND b.state='retained'
 AND b.byte_offset=OLD.decoded_bytes AND b.first_record=OLD.next_record
 AND b.byte_offset+b.byte_length=NEW.decoded_bytes AND b.first_record+b.record_count=NEW.next_record))
BEGIN SELECT RAISE(ABORT,'archive_decode_missing_block'); END;
CREATE TRIGGER archive_receipt_immutable BEFORE UPDATE ON source_archive_record_receipts
BEGIN SELECT RAISE(ABORT,'immutable_archive_record_receipt'); END;
CREATE TRIGGER archive_progress_immutable BEFORE UPDATE ON source_archive_parse_progress
WHEN NEW.observation_set_id!=OLD.observation_set_id OR NEW.next_record<OLD.next_record OR NEW.next_block<OLD.next_block
 OR NEW.observation_count<OLD.observation_count OR NEW.selected_records<OLD.selected_records OR NEW.discovery_ordinal<OLD.discovery_ordinal
 OR (OLD.state IN ('normalized','complete') AND (NEW.next_record!=OLD.next_record OR NEW.next_block!=OLD.next_block
  OR NEW.block_offset!=OLD.block_offset OR NEW.next_variant!=OLD.next_variant OR NEW.observation_count!=OLD.observation_count
  OR NEW.selected_records!=OLD.selected_records OR NEW.excluded_counts_json!=OLD.excluded_counts_json OR NEW.state='normalizing'))
 OR (OLD.state='complete' AND (NEW.state!='complete' OR NEW.discovery_ordinal!=OLD.discovery_ordinal OR NEW.discovery_digest IS NOT OLD.discovery_digest))
BEGIN SELECT RAISE(ABORT,'immutable_archive_parse_progress'); END;

CREATE TRIGGER recovery_source_archive_decodes_insert BEFORE INSERT ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_decodes_insert BEFORE INSERT ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_decodes_insert BEFORE INSERT ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER cleanup_source_archive_decodes_insert BEFORE INSERT ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys k JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE k.snapshot_id=NEW.source_snapshot_id)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND state!='completed')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_source_archive_decodes_update BEFORE UPDATE ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_decodes_update BEFORE UPDATE ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_decodes_update BEFORE UPDATE ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER cleanup_source_archive_decodes_update BEFORE UPDATE ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys k JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE k.snapshot_id=NEW.source_snapshot_id)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND state!='completed')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_source_archive_decodes_delete BEFORE DELETE ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_decodes_delete BEFORE DELETE ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_decodes_delete BEFORE DELETE ON source_archive_decodes
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=OLD.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER source_archive_decodes_audit_delete BEFORE DELETE ON source_archive_decodes
BEGIN SELECT RAISE(ABORT,'immutable_archive_audit'); END;

CREATE TRIGGER recovery_source_archive_blocks_insert BEFORE INSERT ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_blocks_insert BEFORE INSERT ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_blocks_insert BEFORE INSERT ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER cleanup_source_archive_blocks_insert BEFORE INSERT ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys k JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE k.snapshot_id=NEW.source_snapshot_id)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND state!='completed')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_source_archive_blocks_update BEFORE UPDATE ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_blocks_update BEFORE UPDATE ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_blocks_update BEFORE UPDATE ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER cleanup_source_archive_blocks_update BEFORE UPDATE ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys k JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE k.snapshot_id=NEW.source_snapshot_id)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND state!='completed')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_source_archive_blocks_delete BEFORE DELETE ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_blocks_delete BEFORE DELETE ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_blocks_delete BEFORE DELETE ON source_archive_blocks
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=OLD.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER source_archive_blocks_audit_delete BEFORE DELETE ON source_archive_blocks
BEGIN SELECT RAISE(ABORT,'immutable_archive_audit'); END;

CREATE TRIGGER recovery_source_archive_parse_progress_insert BEFORE INSERT ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_parse_progress_insert BEFORE INSERT ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_parse_progress_insert BEFORE INSERT ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id)) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER cleanup_source_archive_parse_progress_insert BEFORE INSERT ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys k JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE k.snapshot_id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id))
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id)) AND state!='completed')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_source_archive_parse_progress_update BEFORE UPDATE ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_parse_progress_update BEFORE UPDATE ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_parse_progress_update BEFORE UPDATE ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id)) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER cleanup_source_archive_parse_progress_update BEFORE UPDATE ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys k JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE k.snapshot_id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id))
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id)) AND state!='completed')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_source_archive_parse_progress_delete BEFORE DELETE ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_parse_progress_delete BEFORE DELETE ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_parse_progress_delete BEFORE DELETE ON source_archive_parse_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=OLD.observation_set_id)) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER source_archive_parse_progress_audit_delete BEFORE DELETE ON source_archive_parse_progress
BEGIN SELECT RAISE(ABORT,'immutable_archive_audit'); END;

CREATE TRIGGER recovery_source_archive_record_receipts_insert BEFORE INSERT ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_record_receipts_insert BEFORE INSERT ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_record_receipts_insert BEFORE INSERT ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id)) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER cleanup_source_archive_record_receipts_insert BEFORE INSERT ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys k JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE k.snapshot_id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id))
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id)) AND state!='completed')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_source_archive_record_receipts_update BEFORE UPDATE ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_record_receipts_update BEFORE UPDATE ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_record_receipts_update BEFORE UPDATE ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id)) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER cleanup_source_archive_record_receipts_update BEFORE UPDATE ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys k JOIN evidence_cleanup_objects d ON d.object_key=k.object_key WHERE k.snapshot_id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id))
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=NEW.observation_set_id)) AND state!='completed')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_source_archive_record_receipts_delete BEFORE DELETE ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_source_archive_record_receipts_delete BEFORE DELETE ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_source_archive_record_receipts_delete BEFORE DELETE ON source_archive_record_receipts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=(SELECT source_snapshot_id FROM source_parse_operations WHERE observation_set_id=OLD.observation_set_id)) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER source_archive_record_receipts_audit_delete BEFORE DELETE ON source_archive_record_receipts
BEGIN SELECT RAISE(ABORT,'immutable_archive_audit'); END;

CREATE TRIGGER archive_observations_require_sealed_decode BEFORE INSERT ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM source_archive_decodes d WHERE d.source_snapshot_id=NEW.source_snapshot_id)
 AND NOT EXISTS(SELECT 1 FROM source_archive_decodes d
 JOIN source_archive_parse_progress p ON p.observation_set_id=NEW.id
 JOIN source_record_progress r ON r.observation_set_id=NEW.id
 WHERE d.source_snapshot_id=NEW.source_snapshot_id AND d.state='decoded' AND p.state='normalized'
 AND p.next_record=d.next_record AND p.next_block=d.next_block AND p.block_offset=0 AND p.next_variant=0
 AND p.observation_count=NEW.observation_count AND r.next_ordinal=NEW.observation_count
 AND json_extract(r.header_json,'$.source_archive.source_snapshot_id')=d.source_snapshot_id
 AND json_extract(r.header_json,'$.source_archive.block_count')=d.next_block
 AND json_extract(r.header_json,'$.source_archive.raw_record_count')=d.next_record
 AND json_extract(r.header_json,'$.source_archive.decoded_bytes')=d.decoded_bytes
 AND json_extract(r.header_json,'$.source_archive.decoded_sha256')=d.decoded_digest
 AND json_extract(r.header_json,'$.source_archive.blocks_sha256')=d.digest)
BEGIN SELECT RAISE(ABORT,'archive_decode_adoption_incomplete'); END;
DROP VIEW evidence_cleanup_inventory;
CREATE VIEW evidence_cleanup_inventory AS
 SELECT ingestion_run_id,content_object_key AS object_key FROM source_capture_operations
 UNION SELECT ingestion_run_id,content_object_key FROM source_snapshots
 UNION SELECT ref.ingestion_run_id,snapshot.content_object_key
 FROM source_capture_operations ref JOIN source_snapshots snapshot ON snapshot.id=ref.reused_source_snapshot_id
 UNION SELECT snapshot.ingestion_run_id,parse.content_object_key
 FROM source_parse_operations parse JOIN source_snapshots snapshot ON snapshot.id=parse.source_snapshot_id
 UNION SELECT snapshot.ingestion_run_id,block.object_key
 FROM source_archive_blocks block JOIN source_snapshots snapshot ON snapshot.id=block.source_snapshot_id;
DROP VIEW evidence_cleanup_snapshot_keys;
CREATE VIEW evidence_cleanup_snapshot_keys AS
 SELECT id AS snapshot_id,content_object_key AS object_key FROM source_snapshots
 UNION SELECT source_snapshot_id,content_object_key FROM source_parse_operations
 UNION SELECT block.source_snapshot_id,block.object_key FROM source_archive_blocks block
 JOIN source_archive_decodes d ON d.source_snapshot_id=block.source_snapshot_id AND d.state='decoded'
 WHERE block.state='retained' AND EXISTS(SELECT 1 FROM source_observation_sets s WHERE s.source_snapshot_id=d.source_snapshot_id);
DROP VIEW evidence_cleanup_retained_keys;
CREATE VIEW evidence_cleanup_retained_keys AS
 SELECT keys.object_key FROM evidence_cleanup_snapshot_keys keys
 JOIN evidence_cleanup_retained_snapshots retained ON retained.snapshot_id=keys.snapshot_id
 UNION SELECT object_key FROM evidence_object_references
 UNION SELECT dependents.object_key FROM evidence_object_references pin
 JOIN evidence_cleanup_snapshot_keys root ON root.object_key=pin.object_key
 JOIN evidence_cleanup_snapshot_keys dependents ON dependents.snapshot_id=root.snapshot_id;

-- A permanent root pin atomically retains the adopted dependency closure. A
-- previously reserved child must fence the root even when the root is intact.
DROP TRIGGER evidence_cleanup_reference_guard;
CREATE TRIGGER evidence_cleanup_reference_guard BEFORE INSERT ON evidence_object_references
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys root
 JOIN evidence_cleanup_snapshot_keys child ON child.snapshot_id=root.snapshot_id
 JOIN evidence_cleanup_objects deleted ON deleted.object_key=child.object_key
 WHERE root.object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

-- Before its first adoption, a decoded block is intentionally absent from the
-- adopted snapshot-key view. Check the prospective closure directly here.
CREATE TRIGGER archive_observation_adoption_cleanup_guard BEFORE INSERT ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM source_archive_blocks block
 JOIN evidence_cleanup_objects deleted ON deleted.object_key=block.object_key
 WHERE block.source_snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

UPDATE catalogue_schema_state SET migration_level=38 WHERE singleton=1;
