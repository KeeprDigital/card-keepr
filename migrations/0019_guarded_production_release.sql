PRAGMA foreign_keys = ON;

CREATE TABLE production_releases (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'requested', 'preflight', 'migrating', 'deploying',
    'smoke_testing', 'succeeded', 'failed'
  )),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_current_revision_id TEXT NOT NULL,
  expected_head_sha TEXT NOT NULL CHECK (
    length(expected_head_sha) = 40
    AND expected_head_sha NOT GLOB '*[^0-9a-f]*'
  ),
  production_target_digest TEXT NOT NULL CHECK (
    length(production_target_digest) = 64
    AND production_target_digest NOT GLOB '*[^0-9a-f]*'
  ),
  expected_migration_level INTEGER NOT NULL CHECK (expected_migration_level > 0),
  recovery_bookmark TEXT NOT NULL,
  recovery_backup_attempt_id TEXT NOT NULL
    REFERENCES catalogue_backup_attempts(idempotency_key),
  replacement_recovery_id TEXT REFERENCES catalogue_recovery_operations(id),
  replacement_database_id TEXT,
  retained_database_id TEXT,
  api_version_id TEXT,
  ingestion_version_id TEXT,
  binding_observation_json TEXT CHECK (
    binding_observation_json IS NULL OR json_valid(binding_observation_json)
  ),
  smoke_evidence_json TEXT CHECK (
    smoke_evidence_json IS NULL OR json_valid(smoke_evidence_json)
  ),
  failure_code TEXT,
  failure_detail TEXT,
  roll_forward_required INTEGER NOT NULL DEFAULT 0
    CHECK (roll_forward_required IN (0, 1)),
  requested_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (replacement_recovery_id IS NULL
      AND replacement_database_id IS NULL AND retained_database_id IS NULL)
    OR (replacement_recovery_id IS NOT NULL
      AND replacement_database_id IS NOT NULL AND retained_database_id IS NOT NULL
      AND replacement_database_id <> retained_database_id)
  ),
  CHECK (
    (state = 'succeeded' AND terminal_at IS NOT NULL
      AND failure_code IS NULL AND failure_detail IS NULL
      AND smoke_evidence_json IS NOT NULL)
    OR (state = 'failed' AND terminal_at IS NOT NULL
      AND failure_code IS NOT NULL AND failure_detail IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed') AND terminal_at IS NULL
      AND failure_code IS NULL AND failure_detail IS NULL)
  )
);

CREATE UNIQUE INDEX one_active_production_release
ON production_releases ((1))
WHERE state IN (
  'requested', 'preflight', 'migrating', 'deploying', 'smoke_testing'
);

CREATE TRIGGER production_release_request_immutable
BEFORE UPDATE OF id, request_json, idempotency_key,
  expected_current_revision_id, expected_head_sha, production_target_digest,
  expected_migration_level, recovery_bookmark, recovery_backup_attempt_id,
  replacement_recovery_id, replacement_database_id, retained_database_id,
  requested_at
ON production_releases
BEGIN
  SELECT RAISE(ABORT, 'production release request is immutable');
END;

CREATE TRIGGER production_release_terminal_immutable
BEFORE UPDATE ON production_releases
WHEN OLD.state IN ('succeeded', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal production release is immutable');
END;

CREATE TRIGGER production_release_transition_is_legal
BEFORE UPDATE OF state ON production_releases
WHEN NOT (
  (OLD.state = 'requested' AND NEW.state IN ('preflight', 'failed'))
  OR (OLD.state = 'preflight' AND NEW.state IN ('migrating', 'failed'))
  OR (OLD.state = 'migrating' AND NEW.state IN ('deploying', 'failed'))
  OR (OLD.state = 'deploying' AND NEW.state IN ('smoke_testing', 'failed'))
  OR (OLD.state = 'smoke_testing' AND NEW.state IN ('succeeded', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal production release transition');
END;

CREATE TRIGGER production_release_no_rollback_after_migration
BEFORE UPDATE OF state ON production_releases
WHEN OLD.state IN ('migrating', 'deploying', 'smoke_testing')
  AND NEW.state = 'failed' AND NEW.roll_forward_required <> 1
BEGIN
  SELECT RAISE(ABORT, 'roll_forward_required');
END;

CREATE TABLE production_release_transitions (
  release_id TEXT NOT NULL REFERENCES production_releases(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  from_state TEXT,
  to_state TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (release_id, ordinal)
);

CREATE TRIGGER production_release_requested_audit
AFTER INSERT ON production_releases
BEGIN
  INSERT INTO production_release_transitions (
    release_id, ordinal, from_state, to_state, evidence_json, observed_at
  ) VALUES (
    NEW.id, 0, NULL, 'requested', NEW.request_json, NEW.requested_at
  );
END;

CREATE TRIGGER production_release_state_audit
AFTER UPDATE OF state ON production_releases
BEGIN
  INSERT INTO production_release_transitions (
    release_id, ordinal, from_state, to_state, evidence_json, observed_at
  ) VALUES (
    NEW.id,
    (SELECT COALESCE(MAX(ordinal), -1) + 1
     FROM production_release_transitions WHERE release_id = NEW.id),
    OLD.state,
    NEW.state,
    json_object(
      'api_version_id', NEW.api_version_id,
      'ingestion_version_id', NEW.ingestion_version_id,
      'binding_observed', NEW.binding_observation_json IS NOT NULL,
      'smoke_observed', NEW.smoke_evidence_json IS NOT NULL,
      'failure_code', NEW.failure_code,
      'roll_forward_required', NEW.roll_forward_required
    ),
    COALESCE(NEW.terminal_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
END;

CREATE TRIGGER production_release_transition_audit_immutable_update
BEFORE UPDATE ON production_release_transitions
BEGIN
  SELECT RAISE(ABORT, 'production release transition audit is immutable');
END;

CREATE TRIGGER production_release_transition_audit_immutable_delete
BEFORE DELETE ON production_release_transitions
BEGIN
  SELECT RAISE(ABORT, 'production release transition audit is immutable');
END;

-- The guard originally read migration_level = 16 because 0017 and 0018
-- shipped without bumps (issue #72); both now bump, so this expects 18.
UPDATE catalogue_schema_state
SET migration_level = 19
WHERE singleton = 1 AND migration_level = 18;
