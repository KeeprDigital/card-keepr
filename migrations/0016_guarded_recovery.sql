PRAGMA foreign_keys = ON;

ALTER TABLE operation_state
ADD COLUMN active_recovery_id TEXT;

ALTER TABLE operation_state
ADD COLUMN recovery_restore_guard TEXT NOT NULL DEFAULT 'clear'
CHECK (recovery_restore_guard IN ('clear', 'blocked'));

-- The release workflow acquires its lease through a bootstrap ingestion row.
-- Keep the database-level gate aligned with the Worker check so neither a new
-- ingestion nor a production-release bootstrap can begin while recovery is
-- blocked.
DROP TRIGGER require_idle_ingestion;
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

CREATE TABLE catalogue_recovery_operations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'restoring', 'validating', 'awaiting_acceptance',
    'accepted', 'failed'
  )),
  method TEXT NOT NULL CHECK (
    method IN ('time_travel', 'replacement_database')
  ),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  target_revision_id TEXT NOT NULL,
  target_bookmark TEXT NOT NULL,
  target_digest TEXT NOT NULL CHECK (
    length(target_digest) = 64
    AND target_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_backup_attempt_id TEXT NOT NULL
    REFERENCES catalogue_backup_attempts(idempotency_key),
  linked_operation_id TEXT REFERENCES catalogue_recovery_operations(id),
  expected_current_revision_id TEXT NOT NULL,
  current_bookmark TEXT,
  restored_bookmark TEXT,
  undo_bookmark TEXT,
  original_database_id TEXT NOT NULL,
  restored_database_id TEXT,
  retained_database_id TEXT,
  expected_schema_migration_level INTEGER NOT NULL CHECK (
    expected_schema_migration_level > 0
  ),
  expected_verification_json TEXT NOT NULL CHECK (
    json_valid(expected_verification_json)
  ),
  verification_json TEXT CHECK (
    verification_json IS NULL OR json_valid(verification_json)
  ),
  verification_idempotency_key TEXT UNIQUE,
  verification_request_digest TEXT,
  acceptance_idempotency_key TEXT UNIQUE,
  acceptance_request_digest TEXT,
  started_at TEXT NOT NULL,
  restored_at TEXT,
  verified_at TEXT,
  accepted_at TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  failed_at TEXT,
  CHECK (
    (state = 'accepted' AND verification_json IS NOT NULL
      AND verification_idempotency_key IS NOT NULL
      AND acceptance_idempotency_key IS NOT NULL
      AND accepted_at IS NOT NULL
      AND failure_code IS NULL AND failure_detail IS NULL AND failed_at IS NULL)
    OR (state = 'failed' AND failure_code IS NOT NULL
      AND failure_detail IS NOT NULL AND failed_at IS NOT NULL
      AND acceptance_idempotency_key IS NULL AND accepted_at IS NULL)
    OR (state = 'awaiting_acceptance' AND verification_json IS NOT NULL
      AND verification_idempotency_key IS NOT NULL AND verified_at IS NOT NULL
      AND acceptance_idempotency_key IS NULL AND accepted_at IS NULL
      AND failure_code IS NULL AND failure_detail IS NULL AND failed_at IS NULL)
    OR (state IN ('preparing', 'restoring', 'validating')
      AND verification_json IS NULL
      AND acceptance_idempotency_key IS NULL AND accepted_at IS NULL
      AND failure_code IS NULL AND failure_detail IS NULL AND failed_at IS NULL)
  )
);

CREATE UNIQUE INDEX one_catalogue_recovery_child_per_failed_operation
ON catalogue_recovery_operations (linked_operation_id)
WHERE linked_operation_id IS NOT NULL;

CREATE UNIQUE INDEX one_active_catalogue_recovery_operation
ON catalogue_recovery_operations ((1))
WHERE state IN (
  'preparing', 'restoring', 'validating', 'awaiting_acceptance'
);

CREATE TRIGGER catalogue_recovery_request_is_immutable
BEFORE UPDATE OF id, method, request_json, idempotency_key,
  target_revision_id, target_bookmark, target_digest,
  source_backup_attempt_id, linked_operation_id,
  expected_current_revision_id, current_bookmark,
  original_database_id, expected_schema_migration_level,
  expected_verification_json, started_at
ON catalogue_recovery_operations
BEGIN
  SELECT RAISE(ABORT, 'catalogue_recovery_request_immutable');
END;

CREATE TRIGGER catalogue_recovery_terminal_is_immutable
BEFORE UPDATE ON catalogue_recovery_operations
WHEN OLD.state IN ('accepted', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal recovery operation is immutable');
END;

CREATE TRIGGER catalogue_recovery_transition_is_legal
BEFORE UPDATE OF state ON catalogue_recovery_operations
WHEN NOT (
  (OLD.state = 'preparing' AND NEW.state IN ('restoring', 'failed'))
  OR (OLD.state = 'restoring' AND NEW.state IN ('validating', 'failed'))
  OR (OLD.state = 'validating'
      AND NEW.state IN ('awaiting_acceptance', 'failed'))
  OR (OLD.state = 'awaiting_acceptance'
      AND NEW.state IN ('accepted', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal recovery transition');
END;

CREATE TRIGGER catalogue_recovery_operations_are_not_deleted
BEFORE DELETE ON catalogue_recovery_operations
BEGIN
  SELECT RAISE(ABORT, 'catalogue_recovery_audit_immutable');
END;

CREATE TRIGGER catalogue_recovery_health_remains_blocked
BEFORE UPDATE OF recovery_health ON operation_state
WHEN OLD.recovery_health = 'blocked'
  AND NEW.recovery_health <> 'blocked'
  AND EXISTS (
    SELECT 1 FROM catalogue_recovery_operations
    WHERE id = OLD.active_recovery_id AND state <> 'accepted'
  )
BEGIN
  SELECT RAISE(ABORT, 'recovery_not_accepted');
END;

UPDATE catalogue_schema_state
SET migration_level = 16
WHERE singleton = 1 AND migration_level = 15;
