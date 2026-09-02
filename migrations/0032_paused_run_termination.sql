-- Issue #68: terminate a paused Ingestion Run deliberately.
--
-- Termination is the owner's explicit decision that a paused run will not be
-- resumed. It is the only path from 'paused' to 'failed': the transition is
-- legal solely when the run carries the stable owner-termination reason and
-- an immutable termination record already exists for it. Every retained
-- Source Snapshot, Source Observation Set, request plan, collection plan,
-- fetch attempt, capture operation, pause record, Workflow Attempt, and
-- transition survives unchanged; the run merely becomes terminal, and the
-- administration action then releases the single active-run reservation.
--
-- One immutable record per terminated run retains the owner decision: which
-- pause was abandoned, when, and under which idempotency key. The stored
-- request digest and response document let an idempotent replay return the
-- original result without applying anything.
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
      'source_workflow_unavailable'
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

-- paused -> failed joins the legal transitions, but only through explicit
-- termination. Every other edge is unchanged from migration 0029.
DROP TRIGGER guard_legal_ingestion_transition;

CREATE TRIGGER guard_legal_ingestion_transition
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state <> NEW.state
  AND NOT (
    (OLD.state = 'planning' AND NEW.state IN ('collecting', 'failed'))
    OR (
      OLD.state = 'collecting'
      AND NEW.state IN ('paused', 'parsing', 'failed')
    )
    OR (OLD.state = 'paused' AND NEW.state = 'collecting')
    OR (
      OLD.state = 'paused'
      AND NEW.state = 'failed'
      AND NEW.failure_code = 'ingestion_run_terminated'
      AND EXISTS (
        SELECT 1 FROM ingestion_run_terminations
        WHERE ingestion_run_id = OLD.id
      )
    )
    OR (OLD.state = 'parsing' AND NEW.state IN ('reconciling', 'failed'))
    OR (
      OLD.state = 'reconciling'
      AND NEW.state IN ('awaiting_approval', 'failed')
    )
    OR (
      OLD.state = 'awaiting_approval'
      AND NEW.state IN (
        'publishing',
        'rejected',
        'expired',
        'failed'
      )
    )
    OR (
      OLD.state = 'publishing'
      AND NEW.state IN ('published', 'failed')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'illegal_ingestion_transition');
END;

UPDATE catalogue_schema_state
SET migration_level = 32
WHERE singleton = 1 AND migration_level = 31;
