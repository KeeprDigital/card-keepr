-- #389: adaptive per-host pacing. Each hostname keeps its current interval,
-- concurrency, clean-response streak, latency baseline and the bounds it was
-- resolved under; backoff and recovery decisions are append-only receipts.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=45
THEN 1 ELSE json_extract('schema_level_mismatch_expected_45','$') END;

ALTER TABLE source_host_pacing ADD COLUMN interval_ms INTEGER CHECK(interval_ms BETWEEN 0 AND 600000);
ALTER TABLE source_host_pacing ADD COLUMN concurrency INTEGER CHECK(concurrency BETWEEN 1 AND 64);
ALTER TABLE source_host_pacing ADD COLUMN clean_streak INTEGER NOT NULL DEFAULT 0 CHECK(clean_streak>=0);
ALTER TABLE source_host_pacing ADD COLUMN latency_baseline_ms INTEGER CHECK(latency_baseline_ms>=0);
ALTER TABLE source_host_pacing ADD COLUMN policy_json TEXT;
ALTER TABLE source_host_pacing ADD COLUMN updated_at TEXT;

CREATE TABLE source_host_pacing_events (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('backoff','recovery')),
  reason TEXT NOT NULL CHECK(reason IN (
    'rate_limited','unavailable','gateway','retry_after','timeout','connection','latency','clean_streak'
  )),
  interval_before_ms INTEGER NOT NULL CHECK(interval_before_ms>=0),
  interval_after_ms INTEGER NOT NULL CHECK(interval_after_ms>=0),
  concurrency_before INTEGER NOT NULL CHECK(concurrency_before>=1),
  concurrency_after INTEGER NOT NULL CHECK(concurrency_after>=1),
  http_status INTEGER,
  retry_after_ms INTEGER CHECK(retry_after_ms>=0),
  latency_ms INTEGER CHECK(latency_ms>=0)
);
CREATE INDEX source_host_pacing_events_run ON source_host_pacing_events(ingestion_run_id,hostname,occurred_at);

CREATE TRIGGER source_host_pacing_event_immutable BEFORE UPDATE ON source_host_pacing_events
BEGIN SELECT RAISE(ABORT,'source_host_pacing_event_immutable'); END;
CREATE TRIGGER source_host_pacing_event_not_deleted BEFORE DELETE ON source_host_pacing_events
BEGIN SELECT RAISE(ABORT,'source_host_pacing_event_immutable'); END;
CREATE TRIGGER recovery_fence_source_host_pacing_events_insert BEFORE INSERT ON source_host_pacing_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_host_pacing_events_insert BEFORE INSERT ON source_host_pacing_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_host_pacing_events_insert BEFORE INSERT ON source_host_pacing_events
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

UPDATE catalogue_schema_state SET migration_level=46 WHERE singleton=1 AND migration_level=45;
SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
