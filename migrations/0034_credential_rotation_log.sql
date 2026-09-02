-- Issue #87 (ADR 0005): rotating a worker bearer key is an operator
-- procedure with no attestation. Each rotation is recorded as one
-- append-only log entry so the history stays queryable after the attested
-- rotation subsystem is deleted. The row is the entry: a replay under the
-- same idempotency key returns it unchanged, and the stored request digest
-- turns a changed request under a reused key into an explicit conflict.
CREATE TABLE credential_rotation_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_class TEXT NOT NULL CHECK (
    credential_class IN ('api_bearer_key', 'ingestion_admin_key')
  ),
  operator_note TEXT NOT NULL CHECK (
    length(operator_note) BETWEEN 1 AND 500
  ),
  recorded_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER guard_credential_rotation_log_update
BEFORE UPDATE ON credential_rotation_log
BEGIN
  SELECT RAISE(ABORT, 'credential_rotation_log_immutable');
END;

CREATE TRIGGER guard_credential_rotation_log_delete
BEFORE DELETE ON credential_rotation_log
BEGIN
  SELECT RAISE(ABORT, 'credential_rotation_log_immutable');
END;

UPDATE catalogue_schema_state
SET migration_level = 34
WHERE singleton = 1 AND migration_level = 33;
