-- Identity and attempt number remain in the immutable attempt table. Runtime
-- progress is a separate mutable fact, keyed to that retained identity.
SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 6
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_6', '$') END;

CREATE TABLE ingestion_workflow_progress (
  workflow_instance_id TEXT PRIMARY KEY REFERENCES ingestion_workflow_attempts(workflow_instance_id),
  last_progress_at TEXT NOT NULL,
  last_work_at TEXT,
  last_step_name TEXT,
  last_phase TEXT CHECK (last_phase IN ('started', 'completed', 'failed'))
);
INSERT INTO ingestion_workflow_progress (workflow_instance_id, last_progress_at)
SELECT workflow_instance_id, created_at FROM ingestion_workflow_attempts;

CREATE TRIGGER workflow_progress_identity_is_immutable
BEFORE UPDATE OF workflow_instance_id ON ingestion_workflow_progress
BEGIN SELECT RAISE(ABORT, 'workflow_progress_identity_immutable'); END;

UPDATE catalogue_schema_state SET migration_level = 7 WHERE singleton = 1;
