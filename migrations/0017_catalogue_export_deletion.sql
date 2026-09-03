-- Schema level 0017: guarded catalogue export deletion.
PRAGMA foreign_keys = ON;

ALTER TABLE catalogue_exports ADD COLUMN maintenance_state TEXT NOT NULL
  DEFAULT 'available' CHECK (maintenance_state IN ('available', 'deleting', 'deleted'));
ALTER TABLE catalogue_exports ADD COLUMN deletion_operation_id TEXT;
ALTER TABLE catalogue_exports ADD COLUMN deleted_at TEXT;

CREATE TABLE catalogue_export_deletion_plans (
  id TEXT PRIMARY KEY,
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  manifest_digest TEXT NOT NULL,
  expected_current_revision_id TEXT NOT NULL,
  object_keys_json TEXT NOT NULL CHECK (json_valid(object_keys_json)),
  component_names_json TEXT NOT NULL CHECK (json_valid(component_names_json)),
  object_set_digest TEXT NOT NULL CHECK (
    length(object_set_digest) = 64 AND object_set_digest NOT GLOB '*[^0-9a-f]*'
  ),
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
  plan_digest TEXT NOT NULL UNIQUE CHECK (
    length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TRIGGER catalogue_export_deletion_plan_immutable_update
BEFORE UPDATE ON catalogue_export_deletion_plans
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_plan_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_plan_immutable_delete
BEFORE DELETE ON catalogue_export_deletion_plans
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_plan_immutable');
END;

CREATE TABLE catalogue_export_deletions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE REFERENCES catalogue_export_deletion_plans(id),
  state TEXT NOT NULL CHECK (state IN ('deleting', 'deleted', 'failed')),
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  manifest_digest TEXT NOT NULL,
  expected_current_revision_id TEXT NOT NULL,
  object_set_digest TEXT NOT NULL CHECK (
    length(object_set_digest) = 64 AND object_set_digest NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  failure_code TEXT,
  retry_owner_idempotency_key TEXT,
  execution_owner_token TEXT,
  execution_lease_expires_at TEXT,
  confirmation_response_json TEXT CHECK (
    confirmation_response_json IS NULL OR json_valid(confirmation_response_json)
  ),
  CHECK (
    (state = 'deleting' AND completed_at IS NULL AND failure_code IS NULL) OR
    (state = 'deleted' AND completed_at IS NOT NULL AND failure_code IS NULL
      AND confirmation_response_json IS NOT NULL) OR
    (state = 'failed' AND completed_at IS NULL AND failure_code IS NOT NULL
      AND confirmation_response_json IS NOT NULL)
  )
);

CREATE TABLE catalogue_export_deletion_tombstones (
  catalogue_revision_id TEXT PRIMARY KEY REFERENCES catalogue_revisions(id),
  deletion_id TEXT NOT NULL UNIQUE REFERENCES catalogue_export_deletions(id),
  manifest_digest TEXT NOT NULL,
  object_set_digest TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

CREATE TABLE catalogue_export_deletion_retries (
  idempotency_key TEXT PRIMARY KEY,
  deletion_id TEXT NOT NULL REFERENCES catalogue_export_deletions(id),
  object_set_digest TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL
);

CREATE TRIGGER catalogue_export_deletion_retry_update_guard
BEFORE UPDATE ON catalogue_export_deletion_retries
WHEN OLD.response_json IS NOT NULL
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.deletion_id <> OLD.deletion_id
  OR NEW.object_set_digest <> OLD.object_set_digest
  OR NEW.request_json <> OLD.request_json
  OR NEW.created_at <> OLD.created_at
  OR NEW.response_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_retry_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_retry_delete_guard
BEFORE DELETE ON catalogue_export_deletion_retries
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_retry_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_tombstone_immutable_update
BEFORE UPDATE ON catalogue_export_deletion_tombstones
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_tombstone_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_tombstone_immutable_delete
BEFORE DELETE ON catalogue_export_deletion_tombstones
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_tombstone_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_operation_guard
BEFORE INSERT ON catalogue_export_deletions
WHEN NOT EXISTS (
  SELECT 1
  FROM catalogue_export_deletion_plans AS plan
  JOIN catalogue_exports AS export
    ON export.catalogue_revision_id = plan.catalogue_revision_id
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  JOIN operation_state AS operation ON operation.singleton = 1
  WHERE plan.id = NEW.plan_id
    AND plan.catalogue_revision_id = NEW.catalogue_revision_id
    AND plan.manifest_digest = NEW.manifest_digest
    AND plan.expected_current_revision_id = NEW.expected_current_revision_id
    AND plan.object_set_digest = NEW.object_set_digest
    AND plan.expires_at > NEW.requested_at
    AND json_extract(NEW.request_json, '$.plan_id') = plan.id
    AND json_extract(NEW.request_json, '$.plan_digest') = plan.plan_digest
    AND json_extract(NEW.request_json, '$.catalogue_revision_id') = plan.catalogue_revision_id
    AND json_extract(NEW.request_json, '$.manifest_digest') = plan.manifest_digest
    AND json_extract(NEW.request_json, '$.expected_current_revision_id') = plan.expected_current_revision_id
    AND json_extract(NEW.request_json, '$.confirmation_revision_id') = plan.catalogue_revision_id
    AND json_extract(NEW.request_json, '$.deletion_id') = NEW.id
    AND json_extract(NEW.request_json, '$.idempotency_key') = NEW.idempotency_key
    AND export.maintenance_state = 'available'
    AND export.manifest_digest = plan.manifest_digest
    AND export.catalogue_revision_id <> catalogue.current_revision_id
    AND catalogue.current_revision_id = plan.expected_current_revision_id
    AND operation.active_ingestion_run_id IS NULL
    AND (
      operation.active_release_id IS NULL OR
      operation.active_release_expires_at <= NEW.requested_at
    )
    AND operation.recovery_health = 'healthy'
)
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_guard_failed');
END;

CREATE TRIGGER catalogue_export_maintenance_transition_guard
BEFORE UPDATE OF maintenance_state, deletion_operation_id, deleted_at
ON catalogue_exports
WHEN NOT (
  (OLD.maintenance_state = 'available' AND NEW.maintenance_state = 'deleting'
    AND OLD.deletion_operation_id IS NULL AND NEW.deletion_operation_id IS NOT NULL
    AND NEW.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM catalogue_export_deletions AS deletion
      WHERE deletion.id = NEW.deletion_operation_id
        AND deletion.catalogue_revision_id = NEW.catalogue_revision_id
        AND deletion.state = 'deleting'
    )) OR
  (OLD.maintenance_state = 'deleting' AND NEW.maintenance_state = 'deleted'
    AND NEW.deletion_operation_id = OLD.deletion_operation_id
    AND NEW.deleted_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_maintenance_transition_invalid');
END;

CREATE TRIGGER catalogue_export_deletion_operation_transition_guard
BEFORE UPDATE ON catalogue_export_deletions
WHEN NOT (
  (OLD.state = 'deleting' AND NEW.state IN ('deleted', 'failed')
    AND NEW.retry_owner_idempotency_key IS OLD.retry_owner_idempotency_key
    AND NEW.execution_owner_token IS OLD.execution_owner_token
    AND NEW.execution_lease_expires_at IS OLD.execution_lease_expires_at) OR
  (OLD.state = 'failed' AND NEW.state = 'deleting'
    AND NEW.retry_owner_idempotency_key IS NOT NULL
    AND NEW.execution_owner_token IS NOT NULL
    AND NEW.execution_lease_expires_at IS NOT NULL) OR
  (OLD.state = 'deleting' AND NEW.state = 'deleting'
    AND NEW.retry_owner_idempotency_key IS OLD.retry_owner_idempotency_key
    AND NEW.execution_owner_token IS NOT NULL
    AND NEW.execution_lease_expires_at IS NOT NULL)
)
OR (
  OLD.state = 'failed' AND NEW.state = 'deleting' AND NOT EXISTS (
    SELECT 1
    FROM catalogue_export_deletion_plans AS plan
    JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
    JOIN operation_state AS operation ON operation.singleton = 1
    WHERE plan.id = OLD.plan_id
      AND plan.object_set_digest = OLD.object_set_digest
      AND catalogue.current_revision_id = OLD.expected_current_revision_id
      AND plan.catalogue_revision_id <> catalogue.current_revision_id
      AND operation.active_ingestion_run_id IS NULL
      AND EXISTS (
        SELECT 1 FROM catalogue_export_deletion_retries AS retry
        WHERE retry.deletion_id = OLD.id
          AND retry.idempotency_key = NEW.retry_owner_idempotency_key
          AND retry.object_set_digest = OLD.object_set_digest
          AND retry.response_json IS NULL
      )
      AND (
        operation.active_release_id IS NULL OR
        operation.active_release_expires_at <= (
          SELECT retry.created_at
          FROM catalogue_export_deletion_retries AS retry
          WHERE retry.deletion_id = OLD.id AND retry.response_json IS NULL
            AND retry.idempotency_key = NEW.retry_owner_idempotency_key
          ORDER BY retry.created_at DESC LIMIT 1
        )
      )
      AND operation.recovery_health = 'healthy'
  )
)
OR NEW.id <> OLD.id
OR NEW.plan_id <> OLD.plan_id
OR NEW.catalogue_revision_id <> OLD.catalogue_revision_id
OR NEW.manifest_digest <> OLD.manifest_digest
OR NEW.expected_current_revision_id <> OLD.expected_current_revision_id
OR NEW.object_set_digest <> OLD.object_set_digest
OR NEW.idempotency_key <> OLD.idempotency_key
OR NEW.request_json <> OLD.request_json
OR NEW.requested_at <> OLD.requested_at
OR (OLD.confirmation_response_json IS NOT NULL
    AND NEW.confirmation_response_json IS NOT OLD.confirmation_response_json)
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_transition_invalid');
END;

CREATE TRIGGER catalogue_export_deletion_operation_immutable_delete
BEFORE DELETE ON catalogue_export_deletions
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_operation_immutable');
END;

-- Schema-level bump added retrospectively (issue #72): the migration
-- originally shipped without one, so a database that had applied it still
-- reported level 16. Production already applied this file, so this edit only
-- affects fresh databases and the per-migration level walk in
-- acceptance/schema-hygiene.test.mjs.
UPDATE catalogue_schema_state
SET migration_level = 17
WHERE singleton = 1 AND migration_level = 16;
