-- #409: image tranches. A plan may select a bounded subset of one discovered
-- request role; every discovered request it does not select is explicitly
-- deferred. Each discovery batch records its deferred requests' count and
-- per-group counts once, keyed by the digest of their sorted identities, in
-- the same atomic batch that admits the selected requests.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=48
THEN 1 ELSE json_extract('schema_level_mismatch_expected_48','$') END;

CREATE TABLE source_discovery_deferrals (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  parent_request_id TEXT NOT NULL,
  deferral_key TEXT NOT NULL CHECK(length(deferral_key)=64 AND deferral_key NOT GLOB '*[^0-9a-f]*'),
  source_lineage TEXT NOT NULL,
  request_role TEXT NOT NULL CHECK(request_role IN ('listing','detail','product_detail','image')),
  deferred_count INTEGER NOT NULL CHECK(deferred_count>=1),
  group_counts_json TEXT NOT NULL CHECK(json_valid(group_counts_json) AND json_type(group_counts_json)='object'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, parent_request_id, deferral_key)
);

CREATE TRIGGER source_discovery_deferral_immutable BEFORE UPDATE ON source_discovery_deferrals
BEGIN SELECT RAISE(ABORT,'source_discovery_deferral_immutable'); END;
CREATE TRIGGER source_discovery_deferral_not_deleted BEFORE DELETE ON source_discovery_deferrals
BEGIN SELECT RAISE(ABORT,'source_discovery_deferral_immutable'); END;
CREATE TRIGGER recovery_fence_source_discovery_deferrals_insert BEFORE INSERT ON source_discovery_deferrals
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_discovery_deferrals_insert BEFORE INSERT ON source_discovery_deferrals
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_discovery_deferrals_insert BEFORE INSERT ON source_discovery_deferrals
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

UPDATE catalogue_schema_state SET migration_level=49 WHERE singleton=1 AND migration_level=48;
SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
