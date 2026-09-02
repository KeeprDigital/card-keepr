-- Issue #64: let an evidence-backed Ingestion Run pause non-terminally when
-- atomic admission of a dynamically discovered request batch would exceed the
-- exact Source Adapter Version's request capacity. 'paused' joins the state
-- vocabulary as a non-terminal state reachable only from 'collecting'; the
-- paused run keeps the single active-run reservation, its expected Catalogue
-- Revision, and every retained Source Request, Source Snapshot, and Source
-- Observation Set. SQLite cannot alter a CHECK constraint, so ingestion_runs
-- is rebuilt byte-identically apart from the widened state CHECK, and every
-- trigger owned by the table is recreated verbatim except
-- guard_legal_ingestion_transition (collecting -> paused becomes legal) and
-- guard_active_ingestion_identity ('paused' joins the states whose exit
-- requires the active-run reservation). The four triggers on other tables
-- whose bodies read ingestion_runs are dropped first and recreated verbatim
-- afterwards so no trigger program ever references the dropped table, and
-- every trigger is recreated in its original creation order because SQLite
-- fires overlapping triggers in that order.
--
-- Rebuild order matters under deferred foreign keys: dropping the referenced
-- table counts one deferred violation per referencing row, and that counter
-- only drains when matching parent keys are inserted afterwards. The retained
-- rows therefore move through an unconstrained holding table, the empty
-- rebuilt table is renamed into place, and the rows are reinserted before the
-- migration transaction commits.
PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = true;

DROP TRIGGER curated_revision_pin_set_matches_run_start;
DROP TRIGGER guard_catalogue_publication;
DROP TRIGGER guard_ingestion_transition_delete;
DROP TRIGGER guard_no_change_result;

CREATE TABLE ingestion_runs_with_pause (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (
    state IN (
      'planning',
      'collecting',
      'paused',
      'parsing',
      'reconciling',
      'awaiting_approval',
      'publishing',
      'published',
      'rejected',
      'expired',
      'failed'
    )
  ),
  selected_games_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expected_current_revision_id TEXT NOT NULL,
  linked_run_id TEXT REFERENCES ingestion_runs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  candidate_digest TEXT,
  candidate_created_at TEXT,
  approval_deadline TEXT,
  approval_json TEXT,
  published_revision_id TEXT,
  export_manifest_digest TEXT,
  terminal_at TEXT,
  candidate_json TEXT NOT NULL,
  approval_idempotency_key TEXT UNIQUE,
  failure_code TEXT,
  progress_json TEXT NOT NULL
    DEFAULT '{"completed_stages":[],"current_stage":"planning"}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  approval_history_json TEXT NOT NULL DEFAULT '[]',
  publication_outcome TEXT CHECK (
    publication_outcome IN ('revision', 'no_change')
  ),
  resulting_revision_id TEXT,
  freshness_checked_at TEXT,
  publication_revision_id TEXT,
  publication_started_at TEXT,
  publication_reconcile_after TEXT,
  publication_manifest_digest TEXT,
  publication_writer_token TEXT,
  candidate_catalogue_digest TEXT,
  operational_request_id TEXT
);

CREATE TABLE ingestion_runs_holding AS SELECT * FROM ingestion_runs;

DROP TABLE ingestion_runs;

ALTER TABLE ingestion_runs_with_pause RENAME TO ingestion_runs;

INSERT INTO ingestion_runs (
  id, state, selected_games_json, started_at,
  expected_current_revision_id, linked_run_id, idempotency_key,
  candidate_digest, candidate_created_at, approval_deadline, approval_json,
  published_revision_id, export_manifest_digest, terminal_at, candidate_json,
  approval_idempotency_key, failure_code, progress_json, warnings_json,
  approval_history_json, publication_outcome, resulting_revision_id,
  freshness_checked_at, publication_revision_id, publication_started_at,
  publication_reconcile_after, publication_manifest_digest,
  publication_writer_token, candidate_catalogue_digest,
  operational_request_id
)
SELECT
  id, state, selected_games_json, started_at,
  expected_current_revision_id, linked_run_id, idempotency_key,
  candidate_digest, candidate_created_at, approval_deadline, approval_json,
  published_revision_id, export_manifest_digest, terminal_at, candidate_json,
  approval_idempotency_key, failure_code, progress_json, warnings_json,
  approval_history_json, publication_outcome, resulting_revision_id,
  freshness_checked_at, publication_revision_id, publication_started_at,
  publication_reconcile_after, publication_manifest_digest,
  publication_writer_token, candidate_catalogue_digest,
  operational_request_id
FROM ingestion_runs_holding;

DROP TABLE ingestion_runs_holding;

CREATE TRIGGER record_initial_ingestion_state
AFTER INSERT ON ingestion_runs
BEGIN
  INSERT INTO ingestion_run_transitions (
    ingestion_run_id,
    from_state,
    to_state,
    transitioned_at
  ) VALUES (
    NEW.id,
    NULL,
    NEW.state,
    NEW.started_at
  );
END;

CREATE TRIGGER record_ingestion_transition
AFTER UPDATE OF state ON ingestion_runs
WHEN OLD.state <> NEW.state
BEGIN
  INSERT INTO ingestion_run_transitions (
    ingestion_run_id,
    from_state,
    to_state,
    transitioned_at
  ) VALUES (
    NEW.id,
    OLD.state,
    NEW.state,
    COALESCE(NEW.terminal_at, NEW.candidate_created_at, NEW.started_at)
  );
END;

CREATE TRIGGER guard_legal_ingestion_transition
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state <> NEW.state
  AND NOT (
    (OLD.state = 'planning' AND NEW.state IN ('collecting', 'failed'))
    OR (
      OLD.state = 'collecting'
      AND NEW.state IN ('paused', 'parsing', 'failed')
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

CREATE TRIGGER guard_active_ingestion_identity
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state <> NEW.state
  AND OLD.state IN (
    'planning',
    'collecting',
    'paused',
    'parsing',
    'reconciling',
    'awaiting_approval',
    'publishing'
  )
  AND NOT (
    OLD.state = 'publishing'
    AND NEW.state = 'failed'
    AND NEW.failure_code IN (
      'publication_abandoned',
      'publication_precondition_failed',
      'export_verification_failed'
    )
  )
  AND NOT (
    OLD.state = 'awaiting_approval'
    AND NEW.state = 'expired'
    AND OLD.approval_deadline IS NOT NULL
    AND NEW.terminal_at >= OLD.approval_deadline
  )
  AND NOT EXISTS (
    SELECT 1
    FROM operation_state
    WHERE singleton = 1
      AND active_ingestion_run_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'run_not_active');
END;

CREATE TRIGGER guard_terminal_ingestion_immutability
BEFORE UPDATE ON ingestion_runs
WHEN OLD.state IN ('published', 'rejected', 'expired', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal_ingestion_run_immutable');
END;

CREATE TRIGGER guard_reserved_approval
BEFORE UPDATE OF
  approval_json,
  approval_history_json,
  approval_idempotency_key,
  publication_revision_id,
  publication_started_at,
  publication_reconcile_after,
  publication_manifest_digest,
  publication_writer_token
ON ingestion_runs
WHEN OLD.state IN (
  'publishing',
  'published',
  'rejected',
  'expired',
  'failed'
)
  AND (
    OLD.approval_json IS NOT NEW.approval_json
    OR OLD.approval_history_json IS NOT NEW.approval_history_json
    OR OLD.approval_idempotency_key
      IS NOT NEW.approval_idempotency_key
    OR OLD.publication_revision_id
      IS NOT NEW.publication_revision_id
    OR OLD.publication_started_at
      IS NOT NEW.publication_started_at
    OR OLD.publication_reconcile_after
      IS NOT NEW.publication_reconcile_after
    OR OLD.publication_manifest_digest
      IS NOT NEW.publication_manifest_digest
    OR OLD.publication_writer_token
      IS NOT NEW.publication_writer_token
  )
BEGIN
  SELECT RAISE(ABORT, 'reserved_approval_immutable');
END;

CREATE TRIGGER guard_approval_transition
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state = 'awaiting_approval'
  AND NEW.state = 'publishing'
  AND NOT (
    NEW.approval_json IS NOT NULL
    AND json_extract(
      NEW.approval_json,
      '$.candidate_digest'
    ) = OLD.candidate_digest
    AND json_extract(
      NEW.approval_json,
      '$.expected_current_revision_id'
    ) = OLD.expected_current_revision_id
    AND json_extract(
      NEW.approval_json,
      '$.approved_at'
    ) < OLD.approval_deadline
    AND EXISTS (
      SELECT 1
      FROM catalogue_state AS catalogue
      JOIN operation_state AS operation ON operation.singleton = 1
      WHERE catalogue.singleton = 1
        AND catalogue.current_revision_id =
          OLD.expected_current_revision_id
        AND operation.active_ingestion_run_id = OLD.id
        AND operation.recovery_health = 'healthy'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'approval_guard_failed');
END;

CREATE TRIGGER guard_catalogue_publication
BEFORE INSERT ON catalogue_revisions
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_runs AS run
  JOIN operation_state AS operation ON operation.singleton = 1
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  WHERE run.id = NEW.ingestion_run_id
    AND run.state = 'publishing'
    AND run.candidate_digest = NEW.approved_candidate_digest
    AND run.expected_current_revision_id =
      NEW.expected_previous_revision_id
    AND json_extract(
      run.approval_json,
      '$.candidate_digest'
    ) = NEW.approved_candidate_digest
    AND json_extract(
      run.approval_json,
      '$.expected_current_revision_id'
    ) = NEW.expected_previous_revision_id
    AND operation.active_ingestion_run_id = run.id
    AND operation.recovery_health = 'healthy'
    AND catalogue.current_revision_id =
      NEW.expected_previous_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication_guard_failed');
END;

CREATE TRIGGER guard_candidate_finalization
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state = 'reconciling'
  AND NEW.state = 'awaiting_approval'
  AND (
    NEW.candidate_digest IS NULL
    OR NEW.candidate_catalogue_digest IS NULL
    OR NEW.candidate_created_at IS NULL
    OR NEW.approval_deadline IS NULL
    OR NEW.approval_deadline <> strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      NEW.candidate_created_at,
      '+7 days'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_candidate_deadline');
END;

CREATE TRIGGER guard_fixed_candidate
BEFORE UPDATE OF
  candidate_digest,
  candidate_catalogue_digest,
  candidate_created_at,
  approval_deadline,
  expected_current_revision_id,
  candidate_json,
  selected_games_json,
  warnings_json
ON ingestion_runs
WHEN OLD.state IN (
  'awaiting_approval',
  'publishing',
  'published',
  'rejected',
  'expired',
  'failed'
)
  AND (
    OLD.candidate_digest IS NOT NEW.candidate_digest
    OR OLD.candidate_catalogue_digest
      IS NOT NEW.candidate_catalogue_digest
    OR OLD.candidate_created_at IS NOT NEW.candidate_created_at
    OR OLD.approval_deadline IS NOT NEW.approval_deadline
    OR OLD.expected_current_revision_id
      IS NOT NEW.expected_current_revision_id
    OR OLD.candidate_json IS NOT NEW.candidate_json
    OR OLD.selected_games_json IS NOT NEW.selected_games_json
    OR OLD.warnings_json IS NOT NEW.warnings_json
  )
BEGIN
  SELECT RAISE(ABORT, 'candidate_immutable');
END;

CREATE TRIGGER guard_no_change_result
BEFORE INSERT ON ingestion_no_change_results
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_runs AS run
  JOIN operation_state AS operation ON operation.singleton = 1
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  JOIN catalogue_revisions AS revision
    ON revision.id = catalogue.current_revision_id
  WHERE run.id = NEW.ingestion_run_id
    AND run.state = 'awaiting_approval'
    AND run.candidate_digest = NEW.candidate_digest
    AND run.expected_current_revision_id = NEW.catalogue_revision_id
    AND operation.active_ingestion_run_id = run.id
    AND operation.recovery_health = 'healthy'
    AND catalogue.current_revision_id = NEW.catalogue_revision_id
    AND revision.content_digest = run.candidate_catalogue_digest
    AND NEW.checked_at < run.approval_deadline
)
BEGIN
  SELECT RAISE(ABORT, 'no_change_guard_failed');
END;

CREATE TRIGGER guard_ingestion_deletion
BEFORE DELETE ON ingestion_runs
WHEN NOT (
  OLD.id LIKE 'release-bootstrap|%'
  AND OLD.idempotency_key = OLD.id
  AND OLD.selected_games_json = '[]'
  AND OLD.candidate_json = '{"production_release_bootstrap":true}'
  AND OLD.state IN ('planning', 'failed')
  AND NOT EXISTS (
    SELECT 1 FROM operation_state
    WHERE singleton = 1 AND active_ingestion_run_id = OLD.id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_audit_immutable');
END;

CREATE TRIGGER guard_ingestion_transition_delete
BEFORE DELETE ON ingestion_run_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs AS run
  WHERE run.id = OLD.ingestion_run_id
    AND run.id LIKE 'release-bootstrap|%'
    AND run.idempotency_key = run.id
    AND run.selected_games_json = '[]'
    AND run.candidate_json = '{"production_release_bootstrap":true}'
    AND run.state IN ('planning', 'failed')
    AND NOT EXISTS (
      SELECT 1 FROM operation_state
      WHERE singleton = 1 AND active_ingestion_run_id = run.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ingestion_transition_audit_immutable');
END;

CREATE TRIGGER curated_revision_pin_set_matches_run_start
BEFORE INSERT ON ingestion_run_curated_revision_sets
WHEN NEW.revision_ids_json <> COALESCE((
  SELECT json_group_array(id) FROM (
    SELECT revision.id
    FROM curated_revisions AS revision
    JOIN ingestion_runs AS run ON run.id = NEW.ingestion_run_id
    WHERE revision.status = 'active'
      AND revision.game IN (SELECT value FROM json_each(run.selected_games_json))
      AND (revision.effective_from IS NULL OR revision.effective_from <= substr(run.started_at, 1, 10))
      AND (revision.effective_to IS NULL OR substr(run.started_at, 1, 10) < revision.effective_to)
    ORDER BY revision.id
  )
), '[]')
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_pin_set_changed');
END;

CREATE TRIGGER curated_revision_reconfirmation_blocks_run
BEFORE INSERT ON ingestion_runs
WHEN EXISTS (
  SELECT 1 FROM curated_revisions AS revision
  WHERE revision.status = 'reconfirmation_required'
    AND revision.game IN (
      SELECT value FROM json_each(NEW.selected_games_json)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_reconfirmation_required');
END;

CREATE TRIGGER require_idle_ingestion
BEFORE INSERT ON ingestion_runs
WHEN EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1 AND (
    active_ingestion_run_id IS NOT NULL
    OR (
      active_release_id IS NOT NULL
      AND active_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'active_ingestion_run_or_release');
END;

CREATE TRIGGER require_recovery_idle_ingestion
BEFORE INSERT ON ingestion_runs
WHEN EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1
    AND (recovery_health = 'blocked' OR recovery_restore_guard = 'blocked')
    AND active_ingestion_run_id IS NULL
    AND NOT (
      active_release_id IS NOT NULL
      AND active_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'recovery_in_progress');
END;

-- One immutable pause record per capacity generation retains the facts the
-- owner needs to choose a meaningful capacity extension: the exact capacity
-- and generation that were exhausted, the unique Source Request identities
-- already held by the Source Lineage, the size of the rejected all-or-nothing
-- overflow batch, and the safe parent Source Request reference whose retained
-- discovery evidence can derive that batch again. Issue #65 advances
-- capacity_generation through compare-and-set extensions; until then every
-- pause records the initial generation 1.
CREATE TABLE ingestion_run_capacity_pauses (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  capacity_generation INTEGER NOT NULL CHECK (capacity_generation >= 1),
  pause_reason TEXT NOT NULL CHECK (
    pause_reason = 'source_request_capacity_exhausted'
  ),
  paused_at TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  parent_request_id TEXT NOT NULL,
  request_capacity INTEGER NOT NULL CHECK (request_capacity >= 1),
  used_capacity INTEGER NOT NULL CHECK (
    used_capacity BETWEEN 0 AND request_capacity
  ),
  overflow_request_count INTEGER NOT NULL CHECK (
    overflow_request_count >= 1
  ),
  required_capacity INTEGER NOT NULL CHECK (
    required_capacity = used_capacity + overflow_request_count
    AND required_capacity > request_capacity
  ),
  PRIMARY KEY (ingestion_run_id, capacity_generation)
);

CREATE TRIGGER guard_capacity_pause_requires_paused_run
BEFORE INSERT ON ingestion_run_capacity_pauses
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'capacity_pause_requires_paused_run');
END;

CREATE TRIGGER guard_capacity_pause_update
BEFORE UPDATE ON ingestion_run_capacity_pauses
BEGIN
  SELECT RAISE(ABORT, 'capacity_pause_immutable');
END;

CREATE TRIGGER guard_capacity_pause_delete
BEFORE DELETE ON ingestion_run_capacity_pauses
BEGIN
  SELECT RAISE(ABORT, 'capacity_pause_immutable');
END;

UPDATE catalogue_schema_state
SET migration_level = 28
WHERE singleton = 1 AND migration_level = 27;
