-- The parent completion barrier records why it stopped driving collection
-- (issue #445). A collecting Ingestion Run whose barrier cannot continue used
-- to leave nothing behind: the #445 parent reached Cloudflare's 10,000 durable
-- steps at barrier stage 3288 and its instance ended with an engine error it
-- could neither observe nor record, so the run sat in 'collecting' with an
-- idle runtime, 2,457 stranded pending Source Requests and no pause of any
-- kind. Two Workflow Pause reasons make that condition owner-visible and
-- resumable:
--
--   source_workflow_attempt_exhausted  this parent Workflow Attempt spent its
--                                      bounded durable-step budget; the run's
--                                      retained work is untouched and resume
--                                      opens the next attempt.
--   source_collection_no_progress      the barrier observed pending Source
--                                      Requests but no collection progress for
--                                      the stall grace period.
--
-- Both record the stranded pending work, so `source show` says how much
-- collection is still owed and to which hosts rather than only naming a
-- Workflow instance.
--
-- SQLite cannot widen a CHECK constraint in place, so the two tables whose
-- CHECK enumerates the Workflow Pause reasons are rebuilt with every retained
-- row and trigger, following migration 0002. No ALTER TABLE RENAME is used: a
-- rename re-parses every trigger in the schema. Each table is copied aside,
-- dropped, recreated under its own name, refilled, and re-guarded.

SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 51
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_51', '$')
END;

-- ingestion_run_workflow_pauses: one immutable record per (run, Workflow
-- instance) Workflow Pause. `stranded_json` is the bounded census of the work
-- the abandoned attempt left pending, recorded only by the barrier's own
-- pauses; every earlier kind keeps it NULL.
CREATE TABLE ingestion_run_workflow_pauses_rebuild AS
SELECT ingestion_run_id, workflow_instance_id, pause_reason, workflow_status,
       paused_at, last_progress_at
FROM ingestion_run_workflow_pauses;

DROP TRIGGER guard_workflow_pause_update;
DROP TRIGGER guard_workflow_pause_delete;
DROP TRIGGER recovery_fence_ingestion_run_workflow_pauses_insert;
DROP TRIGGER recovery_fence_ingestion_run_workflow_pauses_update;
DROP TRIGGER recovery_fence_ingestion_run_workflow_pauses_delete;
DROP TRIGGER handoff_fence_ingestion_run_workflow_pauses_insert;
DROP TRIGGER handoff_fence_ingestion_run_workflow_pauses_update;
DROP TRIGGER handoff_fence_ingestion_run_workflow_pauses_delete;
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
      'source_workflow_attempt_exhausted',
      'source_collection_no_progress',
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
  stranded_json TEXT CHECK (stranded_json IS NULL OR json_valid(stranded_json)),
  PRIMARY KEY (ingestion_run_id, workflow_instance_id)
);

INSERT INTO ingestion_run_workflow_pauses (
  ingestion_run_id, workflow_instance_id, pause_reason, workflow_status,
  paused_at, last_progress_at, stranded_json
)
SELECT ingestion_run_id, workflow_instance_id, pause_reason, workflow_status,
       paused_at, last_progress_at, NULL
FROM ingestion_run_workflow_pauses_rebuild
ORDER BY rowid;

DROP TABLE ingestion_run_workflow_pauses_rebuild;

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

CREATE TRIGGER recovery_fence_ingestion_run_workflow_pauses_insert BEFORE INSERT ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_ingestion_run_workflow_pauses_update BEFORE UPDATE ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_ingestion_run_workflow_pauses_delete BEFORE DELETE ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_workflow_pauses_insert BEFORE INSERT ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_workflow_pauses_update BEFORE UPDATE ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_workflow_pauses_delete BEFORE DELETE ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

-- ingestion_run_terminations: the owner decision that abandons a paused run
-- retains which pause it abandoned, so it must accept the barrier's reasons.
CREATE TABLE ingestion_run_terminations_rebuild AS
SELECT ingestion_run_id, pause_reason, paused_at, terminated_at,
       idempotency_key, request_digest, response_json
FROM ingestion_run_terminations;

DROP TRIGGER guard_termination_update;
DROP TRIGGER guard_termination_delete;
DROP TRIGGER recovery_fence_ingestion_run_terminations_insert;
DROP TRIGGER recovery_fence_ingestion_run_terminations_update;
DROP TRIGGER recovery_fence_ingestion_run_terminations_delete;
DROP TRIGGER handoff_fence_ingestion_run_terminations_insert;
DROP TRIGGER handoff_fence_ingestion_run_terminations_update;
DROP TRIGGER handoff_fence_ingestion_run_terminations_delete;
DROP TABLE ingestion_run_terminations;

CREATE TABLE ingestion_run_terminations (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_request_capacity_exhausted',
      'source_acquisition_budget_exhausted',
      'source_transport_retries_exhausted',
      'source_storage_retries_exhausted',
      'source_workflow_stalled',
      'source_workflow_errored',
      'source_workflow_terminated',
      'source_workflow_unavailable',
      'source_workflow_attempt_exhausted',
      'source_collection_no_progress',
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

CREATE TRIGGER guard_termination_update BEFORE UPDATE ON ingestion_run_terminations
BEGIN SELECT RAISE(ABORT,'termination_immutable'); END;

CREATE TRIGGER guard_termination_delete BEFORE DELETE ON ingestion_run_terminations
BEGIN SELECT RAISE(ABORT,'termination_immutable'); END;

CREATE TRIGGER recovery_fence_ingestion_run_terminations_insert BEFORE INSERT ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_ingestion_run_terminations_update BEFORE UPDATE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_ingestion_run_terminations_delete BEFORE DELETE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_terminations_insert BEFORE INSERT ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_terminations_update BEFORE UPDATE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_terminations_delete BEFORE DELETE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

UPDATE catalogue_schema_state SET migration_level=52 WHERE singleton=1 AND migration_level=51;
SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
