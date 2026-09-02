-- Issue #65: extend the Request Capacity of a capacity-paused Ingestion Run
-- and resume the same run.
--
-- One immutable record per successful extension advances the run's capacity
-- generation through an authenticated, idempotent, compare-and-set
-- administration action. The effective capacity of a Source Lineage within a
-- run becomes the newest extension's absolute capacity (still constrained by
-- the global emergency ceiling); a run without extensions keeps its Source
-- Adapter Version's registered capacity at generation 1. The stored request
-- digest and response document let an idempotent replay return the original
-- result without applying another extension.
CREATE TABLE ingestion_run_capacity_extensions (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  capacity_generation INTEGER NOT NULL CHECK (capacity_generation >= 2),
  previous_request_capacity INTEGER NOT NULL CHECK (
    previous_request_capacity >= 1
  ),
  request_capacity INTEGER NOT NULL CHECK (
    request_capacity > previous_request_capacity
    AND request_capacity BETWEEN 2 AND 24999
  ),
  source_lineage TEXT NOT NULL,
  extended_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  PRIMARY KEY (ingestion_run_id, capacity_generation)
);

CREATE TRIGGER guard_capacity_extension_requires_paused_run
BEFORE INSERT ON ingestion_run_capacity_extensions
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'capacity_extension_requires_paused_run');
END;

CREATE TRIGGER guard_capacity_extension_update
BEFORE UPDATE ON ingestion_run_capacity_extensions
BEGIN
  SELECT RAISE(ABORT, 'capacity_extension_immutable');
END;

CREATE TRIGGER guard_capacity_extension_delete
BEFORE DELETE ON ingestion_run_capacity_extensions
BEGIN
  SELECT RAISE(ABORT, 'capacity_extension_immutable');
END;

-- `keepr source resume` moves a capacity-paused run back into collection:
-- paused -> collecting joins the legal transitions. Every other edge is
-- unchanged from migration 0028.
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
SET migration_level = 29
WHERE singleton = 1 AND migration_level = 28;
