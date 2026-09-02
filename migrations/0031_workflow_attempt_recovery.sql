-- A stalled, errored, terminated, or unavailable collection Workflow pauses
-- the Ingestion Run instead of abandoning it. Parent and hostname-shard child
-- Workflow attempts become append-only records with deterministic identities,
-- so recovery supersedes an attempt by opening a new one without deleting or
-- renumbering history, and exactly one attempt per scope is current.

-- One immutable row per Workflow Attempt. The base identity groups the
-- attempts of one scope (the run's parent Workflow, or one hostname shard),
-- and the highest attempt number per scope is the current attempt.
CREATE TABLE ingestion_workflow_attempts (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('parent', 'child')),
  base_workflow_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  workflow_instance_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (
    ingestion_run_id, workflow_kind, base_workflow_id, attempt_number
  )
);

CREATE TRIGGER workflow_attempts_are_immutable_on_update
BEFORE UPDATE ON ingestion_workflow_attempts
BEGIN
  SELECT RAISE(ABORT, 'workflow_attempt_immutable');
END;

CREATE TRIGGER workflow_attempts_are_immutable_on_delete
BEFORE DELETE ON ingestion_workflow_attempts
BEGIN
  SELECT RAISE(ABORT, 'workflow_attempt_immutable');
END;

-- One immutable record per (run, Workflow instance) Workflow Pause. Unlike
-- the capacity and retry-exhaustion pause tables, the facts here describe
-- the abandoned Workflow Attempt: its safe instance reference, the safe
-- status that classified it, and the deterministic last-progress time the
-- classification was derived from.
CREATE TABLE ingestion_run_workflow_pauses (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  workflow_instance_id TEXT NOT NULL,
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_workflow_stalled',
      'source_workflow_errored',
      'source_workflow_terminated',
      'source_workflow_unavailable'
    )
  ),
  workflow_status TEXT NOT NULL CHECK (
    workflow_status IN (
      'queued',
      'running',
      'paused',
      'errored',
      'terminated',
      'complete',
      'waiting',
      'waiting_for_pause',
      'unknown',
      'unavailable'
    )
  ),
  paused_at TEXT NOT NULL,
  last_progress_at TEXT,
  PRIMARY KEY (ingestion_run_id, workflow_instance_id)
);

CREATE TRIGGER guard_workflow_pause_requires_paused_run
BEFORE INSERT ON ingestion_run_workflow_pauses
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'workflow_pause_requires_paused_run');
END;

CREATE TRIGGER guard_workflow_pause_update
BEFORE UPDATE ON ingestion_run_workflow_pauses
BEGIN
  SELECT RAISE(ABORT, 'workflow_pause_immutable');
END;

CREATE TRIGGER guard_workflow_pause_delete
BEFORE DELETE ON ingestion_run_workflow_pauses
BEGIN
  SELECT RAISE(ABORT, 'workflow_pause_immutable');
END;

UPDATE catalogue_schema_state
SET migration_level = 31
WHERE singleton = 1 AND migration_level = 30;
