-- A backup is useful only when its exact bytes and verified restore are
-- durably attributable to one immutable attempt.
ALTER TABLE catalogue_backup_attempts
ADD COLUMN manifest_key TEXT;

ALTER TABLE catalogue_backup_attempts
ADD COLUMN content_sha256 TEXT;

ALTER TABLE catalogue_backup_attempts
ADD COLUMN manifest_sha256 TEXT;

ALTER TABLE catalogue_backup_attempts
ADD COLUMN export_bytes INTEGER;

ALTER TABLE catalogue_backup_attempts
ADD COLUMN schema_migration_level INTEGER;

ALTER TABLE catalogue_backup_attempts
ADD COLUMN linked_attempt_id TEXT REFERENCES catalogue_backup_attempts(idempotency_key);

ALTER TABLE catalogue_backup_attempts
ADD COLUMN publication_ingestion_run_id TEXT REFERENCES ingestion_runs(id);

ALTER TABLE catalogue_backup_attempts
ADD COLUMN disposable_database_id TEXT;

ALTER TABLE catalogue_backup_attempts
ADD COLUMN restore_generation INTEGER NOT NULL DEFAULT 0
CHECK (restore_generation >= 0);

ALTER TABLE catalogue_backup_attempts
ADD COLUMN restore_phase TEXT
CHECK (restore_phase IN ('prepared', 'importing', 'imported', 'verified'));

-- A pre-0015 verified row proves only that an object was written. It cannot
-- retain healthy recovery status because it predates the durable manifest,
-- digest, restore-target, and complete verification evidence introduced here.
-- A fresh catalogue has no legacy verified rows and remains healthy.
UPDATE operation_state
SET recovery_health = 'degraded'
WHERE singleton = 1
  AND recovery_health = 'healthy'
  AND EXISTS (
    SELECT 1 FROM catalogue_backup_attempts
    WHERE state = 'verified'
      AND (
        manifest_key IS NULL
        OR content_sha256 IS NULL
        OR manifest_sha256 IS NULL
        OR export_bytes IS NULL
        OR schema_migration_level IS NULL
        OR disposable_database_id IS NULL
        OR restore_phase IS NULL
      )
  );

CREATE TRIGGER catalogue_backup_verified_evidence_required
BEFORE UPDATE OF state ON catalogue_backup_attempts
WHEN NEW.state = 'verified' AND NOT (
  NEW.manifest_key IS NOT NULL
  AND NEW.content_sha256 NOT GLOB '*[^0-9a-f]*'
  AND length(NEW.content_sha256) = 64
  AND NEW.manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  AND length(NEW.manifest_sha256) = 64
  AND NEW.export_bytes >= 0
  AND NEW.schema_migration_level > 0
  AND length(NEW.disposable_database_id) > 0
  AND NEW.restore_generation > 0
  AND NEW.restore_phase = 'verified'
)
BEGIN
  SELECT RAISE(ABORT, 'verified backup evidence is incomplete');
END;

CREATE TABLE catalogue_schema_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  migration_level INTEGER NOT NULL CHECK (migration_level > 0)
);

INSERT INTO catalogue_schema_state (singleton, migration_level)
VALUES (1, 15);

CREATE TABLE catalogue_backup_retention (
  attempt_id TEXT PRIMARY KEY REFERENCES catalogue_backup_attempts(idempotency_key),
  newest_success INTEGER NOT NULL CHECK (newest_success IN (0, 1)),
  retain_until TEXT,
  policy TEXT NOT NULL CHECK (policy = 'newest-indefinite-and-dated-90-days'),
  CHECK (
    (newest_success = 1 AND retain_until IS NULL)
    OR (newest_success = 0 AND retain_until GLOB '[0-9][0-9][0-9][0-9]-*Z')
  )
);

CREATE UNIQUE INDEX one_newest_successful_catalogue_backup
ON catalogue_backup_retention (newest_success)
WHERE newest_success = 1;
