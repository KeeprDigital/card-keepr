ALTER TABLE ingestion_runs
ADD COLUMN failure_code TEXT;

ALTER TABLE ingestion_runs
ADD COLUMN progress_json TEXT NOT NULL
DEFAULT '{"completed_stages":[],"current_stage":"planning"}';

ALTER TABLE ingestion_runs
ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE ingestion_runs
ADD COLUMN approval_history_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE ingestion_runs
ADD COLUMN publication_outcome TEXT CHECK (
  publication_outcome IN ('revision', 'no_change')
);

ALTER TABLE ingestion_runs
ADD COLUMN resulting_revision_id TEXT;

ALTER TABLE ingestion_runs
ADD COLUMN freshness_checked_at TEXT;

CREATE TABLE administration_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'problem')),
  created_at TEXT NOT NULL
);

CREATE TABLE ingestion_run_transitions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  transitioned_at TEXT NOT NULL
);

CREATE TABLE source_freshness (
  game TEXT NOT NULL,
  area TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  PRIMARY KEY (game, area)
);

CREATE TABLE ingestion_no_change_results (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  catalogue_revision_id TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

UPDATE ingestion_runs
SET progress_json = CASE state
  WHEN 'planning' THEN
    '{"completed_stages":[],"current_stage":"planning"}'
  WHEN 'collecting' THEN
    '{"completed_stages":["planning"],"current_stage":"collecting"}'
  WHEN 'parsing' THEN
    '{"completed_stages":["planning","collecting"],"current_stage":"parsing"}'
  WHEN 'reconciling' THEN
    '{"completed_stages":["planning","collecting","parsing"],"current_stage":"reconciling"}'
  WHEN 'awaiting_approval' THEN
    '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"awaiting_approval"}'
  WHEN 'publishing' THEN
    '{"completed_stages":["planning","collecting","parsing","reconciling","awaiting_approval"],"current_stage":"publishing"}'
  WHEN 'published' THEN
    '{"completed_stages":["planning","collecting","parsing","reconciling","awaiting_approval","publishing"],"current_stage":"' || state || '"}'
  WHEN 'rejected' THEN
    '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"rejected"}'
  WHEN 'expired' THEN
    '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"expired"}'
  WHEN 'failed' THEN CASE
    WHEN approval_json IS NOT NULL THEN
      '{"completed_stages":["planning","collecting","parsing","reconciling","awaiting_approval"],"current_stage":"failed"}'
    ELSE
      '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}'
  END
END;

UPDATE ingestion_runs
SET approval_history_json = json_array(json(approval_json))
WHERE approval_json IS NOT NULL;

UPDATE ingestion_runs
SET publication_outcome = 'revision',
    resulting_revision_id = published_revision_id
WHERE state = 'published'
  AND published_revision_id IS NOT NULL;

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
    OR (OLD.state = 'collecting' AND NEW.state IN ('parsing', 'failed'))
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
    'parsing',
    'reconciling',
    'awaiting_approval',
    'publishing'
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

CREATE TRIGGER guard_ingestion_deletion
BEFORE DELETE ON ingestion_runs
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_audit_immutable');
END;

CREATE TRIGGER guard_ingestion_transition_update
BEFORE UPDATE ON ingestion_run_transitions
BEGIN
  SELECT RAISE(ABORT, 'ingestion_transition_audit_immutable');
END;

CREATE TRIGGER guard_ingestion_transition_delete
BEFORE DELETE ON ingestion_run_transitions
BEGIN
  SELECT RAISE(ABORT, 'ingestion_transition_audit_immutable');
END;

CREATE TRIGGER guard_administration_idempotency_update
BEFORE UPDATE ON administration_idempotency
BEGIN
  SELECT RAISE(ABORT, 'administration_idempotency_immutable');
END;

CREATE TRIGGER guard_administration_idempotency_delete
BEFORE DELETE ON administration_idempotency
BEGIN
  SELECT RAISE(ABORT, 'administration_idempotency_immutable');
END;

CREATE TRIGGER guard_no_change_result_update
BEFORE UPDATE ON ingestion_no_change_results
BEGIN
  SELECT RAISE(ABORT, 'ingestion_no_change_result_immutable');
END;

CREATE TRIGGER guard_no_change_result_delete
BEFORE DELETE ON ingestion_no_change_results
BEGIN
  SELECT RAISE(ABORT, 'ingestion_no_change_result_immutable');
END;

CREATE TRIGGER guard_candidate_finalization
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state = 'reconciling'
  AND NEW.state = 'awaiting_approval'
  AND (
    NEW.candidate_digest IS NULL
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
  candidate_created_at,
  approval_deadline,
  expected_current_revision_id,
  candidate_json
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
    OR OLD.candidate_created_at IS NOT NEW.candidate_created_at
    OR OLD.approval_deadline IS NOT NEW.approval_deadline
    OR OLD.expected_current_revision_id
      IS NOT NEW.expected_current_revision_id
    OR OLD.candidate_json IS NOT NEW.candidate_json
  )
BEGIN
  SELECT RAISE(ABORT, 'candidate_immutable');
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
    AND revision.content_digest = NEW.candidate_digest
    AND NEW.checked_at < run.approval_deadline
)
BEGIN
  SELECT RAISE(ABORT, 'no_change_guard_failed');
END;

DROP TRIGGER guard_catalogue_publication;

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
