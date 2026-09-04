-- Ingestion Run transition edges come from shared/ingestion-run-state.ts.
-- acceptance/ingestion-run-state.test.mjs verifies this installed trigger for
-- every state pair and termination fact combination. IS closes SQL's NULL
-- loophole: a termination record alone cannot fail a paused run without its code.
SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 4
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_4', '$')
END;

DROP TRIGGER guard_legal_ingestion_transition;
CREATE TRIGGER guard_legal_ingestion_transition
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state <> NEW.state
  AND NOT (
    (OLD.state = 'planning' AND NEW.state = 'collecting')
    OR
    (OLD.state = 'planning' AND NEW.state = 'failed')
    OR
    (OLD.state = 'collecting' AND NEW.state = 'paused')
    OR
    (OLD.state = 'collecting' AND NEW.state = 'parsing')
    OR
    (OLD.state = 'collecting' AND NEW.state = 'failed')
    OR
    (OLD.state = 'paused' AND NEW.state = 'collecting')
    OR
    (OLD.state = 'paused' AND NEW.state = 'failed'
      AND NEW.failure_code IS 'ingestion_run_terminated'
      AND EXISTS (SELECT 1 FROM ingestion_run_terminations WHERE ingestion_run_id = OLD.id))
    OR
    (OLD.state = 'parsing' AND NEW.state = 'reconciling')
    OR
    (OLD.state = 'parsing' AND NEW.state = 'failed')
    OR
    (OLD.state = 'reconciling' AND NEW.state = 'awaiting_approval')
    OR
    (OLD.state = 'reconciling' AND NEW.state = 'failed')
    OR
    (OLD.state = 'awaiting_approval' AND NEW.state = 'publishing')
    OR
    (OLD.state = 'awaiting_approval' AND NEW.state = 'rejected')
    OR
    (OLD.state = 'awaiting_approval' AND NEW.state = 'expired')
    OR
    (OLD.state = 'awaiting_approval' AND NEW.state = 'failed')
    OR
    (OLD.state = 'publishing' AND NEW.state = 'published')
    OR
    (OLD.state = 'publishing' AND NEW.state = 'failed')
  )
BEGIN
  SELECT RAISE(ABORT, 'illegal_ingestion_transition');
END;

UPDATE catalogue_schema_state SET migration_level = 5 WHERE singleton = 1;
