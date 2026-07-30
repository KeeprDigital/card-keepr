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
  production_target_identity TEXT NOT NULL,
  required_permission TEXT NOT NULL,
  cloudflare_management_required_permissions TEXT NOT NULL,
  consumer_installation_identity TEXT NOT NULL,
  old_consumer_slot TEXT NOT NULL CHECK (old_consumer_slot IN ('a', 'b')),
  replacement_consumer_slot TEXT NOT NULL CHECK (
    replacement_consumer_slot IN ('a', 'b')
    AND replacement_consumer_slot <> old_consumer_slot
  ),
  expected_catalogue_revision_id TEXT NOT NULL,
  expected_state_generation INTEGER NOT NULL,
  expected_rotation_state TEXT,
  old_fingerprint TEXT NOT NULL,
  replacement_fingerprint TEXT NOT NULL,
  old_issuer_credential_id TEXT NOT NULL,
  replacement_issuer_credential_id TEXT NOT NULL,
  management_credential_id TEXT NOT NULL,
  github_management_credential_id TEXT NOT NULL,
  github_management_credential_fingerprint TEXT NOT NULL,
  github_management_required_permission TEXT NOT NULL,
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
  execution_expires_at TEXT,
  execution_attempt INTEGER NOT NULL DEFAULT 0,
  execution_owner_hash TEXT,
  execution_capability_hash TEXT,
  execution_capability_consumed_at TEXT,
  boundary_attestation_issued_at TEXT,
  finalized_at TEXT,
  attestation_digest TEXT
);

CREATE UNIQUE INDEX one_reserved_credential_plan_per_class
ON credential_rotation_plans (credential_class)
WHERE status IN ('reserved', 'executing');

CREATE UNIQUE INDEX one_executing_credential_plan
ON credential_rotation_plans ((1))
WHERE status = 'executing';

CREATE TABLE credential_consumer_proof_uses (
  request_nonce TEXT PRIMARY KEY CHECK (
    length(request_nonce) = 64
    AND request_nonce NOT GLOB '*[^0-9a-f]*'
  ),
  plan_id TEXT NOT NULL,
  execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
  credential_class TEXT NOT NULL,
  consumed_at TEXT NOT NULL
);

CREATE TRIGGER block_ingestion_during_credential_execution
BEFORE UPDATE OF active_ingestion_run_id ON operation_state
WHEN OLD.active_ingestion_run_id IS NULL
  AND NEW.active_ingestion_run_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM credential_rotation_plans WHERE status = 'executing'
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_execution_in_progress');
END;

CREATE TRIGGER block_recovery_during_credential_execution
BEFORE UPDATE OF recovery_health ON operation_state
WHEN NEW.recovery_health <> OLD.recovery_health
  AND EXISTS (
    SELECT 1 FROM credential_rotation_plans WHERE status = 'executing'
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_execution_in_progress');
END;

CREATE TRIGGER block_catalogue_reconciliation_during_credential_execution
BEFORE UPDATE OF current_revision_id ON catalogue_state
WHEN NEW.current_revision_id <> OLD.current_revision_id
  AND EXISTS (
    SELECT 1 FROM credential_rotation_plans WHERE status = 'executing'
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_execution_in_progress');
END;

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
  production_target_identity TEXT NOT NULL,
  required_permission TEXT NOT NULL,
  cloudflare_management_required_permissions TEXT NOT NULL,
  consumer_installation_identity TEXT NOT NULL,
  old_consumer_slot TEXT NOT NULL CHECK (old_consumer_slot IN ('a', 'b')),
  replacement_consumer_slot TEXT NOT NULL CHECK (
    replacement_consumer_slot IN ('a', 'b')
    AND replacement_consumer_slot <> old_consumer_slot
  ),
  current_consumer_slot TEXT NOT NULL CHECK (
    current_consumer_slot IN ('a', 'b')
  ),
  old_issuer_credential_id TEXT NOT NULL,
  replacement_issuer_credential_id TEXT NOT NULL,
  management_credential_id TEXT NOT NULL,
  github_management_credential_id TEXT NOT NULL,
  github_management_credential_fingerprint TEXT NOT NULL,
  github_management_required_permission TEXT NOT NULL,
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
    OR NEW.execution_capability_consumed_at IS NULL
    OR NEW.boundary_attestation_issued_at IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM operation_state AS operation
      JOIN credential_rotations AS rotation
        ON rotation.id = NEW.rotation_id
      WHERE operation.singleton = 1
        AND operation.credential_rotation_generation =
          NEW.expected_state_generation + 1
        AND rotation.credential_class = NEW.credential_class
        AND rotation.environment = NEW.environment
        AND rotation.resource_identity = NEW.resource_identity
        AND rotation.owning_boundary = NEW.owning_boundary
        AND rotation.verification_target = NEW.verification_target
        AND rotation.production_target_identity =
          NEW.production_target_identity
        AND rotation.required_permission = NEW.required_permission
        AND rotation.cloudflare_management_required_permissions =
          NEW.cloudflare_management_required_permissions
        AND rotation.consumer_installation_identity =
          NEW.consumer_installation_identity
        AND rotation.old_consumer_slot = NEW.old_consumer_slot
        AND rotation.replacement_consumer_slot =
          NEW.replacement_consumer_slot
        AND rotation.old_issuer_credential_id =
          NEW.old_issuer_credential_id
        AND rotation.replacement_issuer_credential_id =
          NEW.replacement_issuer_credential_id
        AND rotation.management_credential_id =
          NEW.management_credential_id
        AND rotation.github_management_credential_id =
          NEW.github_management_credential_id
        AND rotation.github_management_credential_fingerprint =
          NEW.github_management_credential_fingerprint
        AND rotation.github_management_required_permission =
          NEW.github_management_required_permission
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
