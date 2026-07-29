PRAGMA foreign_keys = ON;

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
