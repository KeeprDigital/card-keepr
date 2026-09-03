-- Owner-initiated stop for a collecting Ingestion Run (issue #140). The
-- owner may pause a collecting run deliberately; the pause is recorded as a
-- Workflow Pause with the reason 'owner_requested', abandoning the current
-- parent Workflow Attempt exactly like a classified recovery does, and the
-- paused run then resumes or is terminated through the ordinary actions.
--
-- SQLite cannot widen a CHECK constraint in place, so the two tables whose
-- CHECK enumerates the Workflow Pause reasons are rebuilt with every retained
-- row and trigger. No ALTER TABLE RENAME is used: a rename re-parses every
-- trigger in the schema, and guard_legal_ingestion_transition on
-- ingestion_runs references ingestion_run_terminations. Each table is
-- therefore copied aside, dropped, recreated under its own name, refilled,
-- and re-guarded. The insert guards are recreated only after the refill,
-- because retained rows belong to runs that are no longer paused.

SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 1
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_1', '$')
END;

-- ingestion_run_workflow_pauses: one immutable record per (run, Workflow
-- instance) Workflow Pause. An owner-requested pause records the parent
-- attempt it abandoned, the safe status observed at the time, and the
-- deterministic last-progress time, like every other kind.
CREATE TABLE ingestion_run_workflow_pauses_rebuild AS
SELECT ingestion_run_id, workflow_instance_id, pause_reason, workflow_status,
       paused_at, last_progress_at
FROM ingestion_run_workflow_pauses;

DROP TRIGGER guard_workflow_pause_requires_paused_run;
DROP TRIGGER guard_workflow_pause_update;
DROP TRIGGER guard_workflow_pause_delete;
DROP TABLE ingestion_run_workflow_pauses;

CREATE TABLE ingestion_run_workflow_pauses (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  workflow_instance_id TEXT NOT NULL,
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_workflow_stalled',
      'source_workflow_errored',
      'source_workflow_terminated',
      'source_workflow_unavailable',
      'owner_requested'
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

INSERT INTO ingestion_run_workflow_pauses (
  ingestion_run_id, workflow_instance_id, pause_reason, workflow_status,
  paused_at, last_progress_at
)
SELECT ingestion_run_id, workflow_instance_id, pause_reason, workflow_status,
       paused_at, last_progress_at
FROM ingestion_run_workflow_pauses_rebuild
ORDER BY rowid;

DROP TABLE ingestion_run_workflow_pauses_rebuild;

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

-- ingestion_run_terminations: the owner decision that abandons a paused run
-- retains which pause it abandoned, so the abandoned pause may now be the
-- owner's own request.
CREATE TABLE ingestion_run_terminations_rebuild AS
SELECT ingestion_run_id, pause_reason, paused_at, terminated_at,
       idempotency_key, request_digest, response_json
FROM ingestion_run_terminations;

DROP TRIGGER guard_termination_requires_paused_run;
DROP TRIGGER guard_termination_update;
DROP TRIGGER guard_termination_delete;
DROP TABLE ingestion_run_terminations;

CREATE TABLE ingestion_run_terminations (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_request_capacity_exhausted',
      'source_transport_retries_exhausted',
      'source_storage_retries_exhausted',
      'source_workflow_stalled',
      'source_workflow_errored',
      'source_workflow_terminated',
      'source_workflow_unavailable',
      'owner_requested'
    )
  ),
  paused_at TEXT NOT NULL,
  terminated_at TEXT NOT NULL CHECK (terminated_at >= paused_at),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json))
);

INSERT INTO ingestion_run_terminations (
  ingestion_run_id, pause_reason, paused_at, terminated_at,
  idempotency_key, request_digest, response_json
)
SELECT ingestion_run_id, pause_reason, paused_at, terminated_at,
       idempotency_key, request_digest, response_json
FROM ingestion_run_terminations_rebuild
ORDER BY rowid;

DROP TABLE ingestion_run_terminations_rebuild;

CREATE TRIGGER guard_termination_requires_paused_run
BEFORE INSERT ON ingestion_run_terminations
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'termination_requires_paused_run');
END;

CREATE TRIGGER guard_termination_update
BEFORE UPDATE ON ingestion_run_terminations
BEGIN
  SELECT RAISE(ABORT, 'termination_immutable');
END;

CREATE TRIGGER guard_termination_delete
BEFORE DELETE ON ingestion_run_terminations
BEGIN
  SELECT RAISE(ABORT, 'termination_immutable');
END;

UPDATE catalogue_schema_state
SET migration_level = 2
WHERE singleton = 1;
