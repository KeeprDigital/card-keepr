-- Recoverable transport and R2 persistence retry exhaustion pause the
-- Ingestion Run instead of failing it. Each Source Request carries a bounded
-- retry generation: attempts stay append-only and monotonically numbered, and
-- resuming a paused run opens the next generation by raising the counted
-- budget window rather than deleting or renumbering earlier attempts.

ALTER TABLE source_requests
ADD COLUMN retry_generation INTEGER NOT NULL DEFAULT 1
  CHECK (retry_generation >= 1);

-- One immutable record per (run, request, generation) retry-exhaustion pause.
-- Unlike ingestion_run_capacity_pauses, the facts here describe the exhausted
-- request, not lineage capacity: the safe request reference, its hostname,
-- the exhausted generation, and the latest safe failure classification.
CREATE TABLE ingestion_run_retry_pauses (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  request_id TEXT NOT NULL,
  retry_generation INTEGER NOT NULL CHECK (retry_generation >= 1),
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_transport_retries_exhausted',
      'source_storage_retries_exhausted'
    )
  ),
  paused_at TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  hostname TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  failure_classification TEXT NOT NULL CHECK (
    failure_classification IN (
      'network_failure',
      'http_failure',
      'storage_failure'
    )
  ),
  http_status INTEGER,
  PRIMARY KEY (ingestion_run_id, request_id, retry_generation),
  FOREIGN KEY (ingestion_run_id, request_id)
    REFERENCES source_requests (ingestion_run_id, request_id),
  -- The pause reason and the recorded classification must agree: storage
  -- exhaustion is exactly the storage_failure outcome, transport exhaustion
  -- is exactly the network and retryable HTTP outcomes.
  CHECK (
    (pause_reason = 'source_storage_retries_exhausted')
    = (failure_classification = 'storage_failure')
  )
);

CREATE TRIGGER guard_retry_pause_requires_paused_run
BEFORE INSERT ON ingestion_run_retry_pauses
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'retry_pause_requires_paused_run');
END;

CREATE TRIGGER guard_retry_pause_update
BEFORE UPDATE ON ingestion_run_retry_pauses
BEGIN
  SELECT RAISE(ABORT, 'retry_pause_immutable');
END;

CREATE TRIGGER guard_retry_pause_delete
BEFORE DELETE ON ingestion_run_retry_pauses
BEGIN
  SELECT RAISE(ABORT, 'retry_pause_immutable');
END;

UPDATE catalogue_schema_state
SET migration_level = 30
WHERE singleton = 1 AND migration_level = 29;
