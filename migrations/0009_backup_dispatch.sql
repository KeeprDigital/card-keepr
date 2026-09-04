SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 8
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_8', '$') END;

CREATE TABLE catalogue_backup_dispatch (
  idempotency_key TEXT PRIMARY KEY REFERENCES catalogue_backup_workflow_requests(idempotency_key),
  state TEXT NOT NULL CHECK (state IN ('pending', 'failed', 'dispatched')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_detail TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO catalogue_backup_dispatch (idempotency_key, state, updated_at)
SELECT request.idempotency_key,
       CASE WHEN attempt.state IS NOT NULL AND attempt.state <> 'pending' THEN 'dispatched' ELSE 'pending' END,
       request.observed_at
FROM catalogue_backup_workflow_requests AS request
LEFT JOIN catalogue_backup_attempts AS attempt ON attempt.idempotency_key = request.idempotency_key;
UPDATE catalogue_schema_state SET migration_level = 9 WHERE singleton = 1;
