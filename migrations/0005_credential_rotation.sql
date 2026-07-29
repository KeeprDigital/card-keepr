PRAGMA foreign_keys = ON;

ALTER TABLE operation_state
ADD COLUMN credential_rotation_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE credential_rotation_plans (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('install', 'verify', 'revoke')),
  rotation_id TEXT NOT NULL,
  credential_class TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment = 'production'),
  cloudflare_account_id TEXT NOT NULL,
  resource_identity TEXT NOT NULL,
  owning_boundary TEXT NOT NULL,
  verification_target TEXT NOT NULL,
  required_permission TEXT NOT NULL,
  expected_catalogue_revision_id TEXT NOT NULL,
  expected_state_generation INTEGER NOT NULL,
  expected_rotation_state TEXT,
  old_fingerprint TEXT NOT NULL,
  replacement_fingerprint TEXT NOT NULL,
  old_issuer_credential_id TEXT NOT NULL,
  replacement_issuer_credential_id TEXT NOT NULL,
  management_credential_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  plan_nonce TEXT NOT NULL UNIQUE,
  plan_digest TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'executing', 'finalized', 'expired')
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  execution_started_at TEXT,
  finalized_at TEXT,
  attestation_digest TEXT
);

CREATE UNIQUE INDEX one_reserved_credential_plan_per_class
ON credential_rotation_plans (credential_class)
WHERE status IN ('reserved', 'executing');

CREATE TABLE credential_rotations (
  id TEXT PRIMARY KEY,
  credential_class TEXT NOT NULL CHECK (
    credential_class IN (
      'api_bearer_key',
      'ingestion_admin_key',
      'd1_export_token',
      'd1_verification_token',
      'github_deployment_token'
    )
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'replacement_installed',
      'replacement_verified',
      'old_revoked'
    )
  ),
  environment TEXT NOT NULL CHECK (environment = 'production'),
  resource_identity TEXT NOT NULL,
  owning_boundary TEXT NOT NULL,
  verification_target TEXT NOT NULL,
  old_secret_hash TEXT NOT NULL CHECK (
    length(old_secret_hash) = 64
    AND old_secret_hash NOT GLOB '*[^0-9a-f]*'
  ),
  replacement_secret_hash TEXT NOT NULL CHECK (
    length(replacement_secret_hash) = 64
    AND replacement_secret_hash NOT GLOB '*[^0-9a-f]*'
  ),
  installed_at TEXT NOT NULL,
  verified_at TEXT,
  old_revoked_at TEXT,
  install_idempotency_key TEXT NOT NULL UNIQUE,
  install_request_digest TEXT NOT NULL,
  verification_idempotency_key TEXT UNIQUE,
  verification_request_digest TEXT,
  revocation_idempotency_key TEXT UNIQUE,
  revocation_request_digest TEXT,
  install_receipt TEXT NOT NULL,
  verification_receipt TEXT,
  revocation_receipt TEXT,
  CHECK (old_secret_hash <> replacement_secret_hash),
  CHECK (
    (state = 'replacement_installed'
      AND verified_at IS NULL
      AND old_revoked_at IS NULL)
    OR
    (state = 'replacement_verified'
      AND verified_at IS NOT NULL
      AND old_revoked_at IS NULL)
    OR
    (state = 'old_revoked'
      AND verified_at IS NOT NULL
      AND old_revoked_at IS NOT NULL)
  )
);

CREATE TRIGGER guard_credential_plan_finalization
BEFORE UPDATE OF status ON credential_rotation_plans
WHEN OLD.status = 'executing' AND NEW.status = 'finalized'
  AND (
    NEW.attestation_digest IS NULL
    OR NEW.finalized_at IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM operation_state AS operation
      JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
      JOIN credential_rotations AS rotation
        ON rotation.id = NEW.rotation_id
      WHERE operation.singleton = 1
        AND operation.recovery_health = 'healthy'
        AND operation.active_ingestion_run_id IS NULL
        AND operation.credential_rotation_generation =
          NEW.expected_state_generation + 1
        AND catalogue.current_revision_id =
          NEW.expected_catalogue_revision_id
        AND rotation.credential_class = NEW.credential_class
        AND rotation.environment = NEW.environment
        AND rotation.resource_identity = NEW.resource_identity
        AND rotation.owning_boundary = NEW.owning_boundary
        AND rotation.verification_target = NEW.verification_target
        AND rotation.old_secret_hash =
          substr(NEW.old_fingerprint, 8)
        AND rotation.replacement_secret_hash =
          substr(NEW.replacement_fingerprint, 8)
        AND rotation.state = CASE NEW.action
          WHEN 'install' THEN 'replacement_installed'
          WHEN 'verify' THEN 'replacement_verified'
          WHEN 'revoke' THEN 'old_revoked'
        END
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_plan_finalize_guard_failed');
END;

CREATE UNIQUE INDEX one_active_credential_rotation_per_class
ON credential_rotations (credential_class)
WHERE state <> 'old_revoked';

CREATE INDEX credential_rotation_old_hash
ON credential_rotations (credential_class, old_secret_hash, state);

CREATE INDEX credential_rotation_replacement_hash
ON credential_rotations (
  credential_class,
  replacement_secret_hash,
  state
);
