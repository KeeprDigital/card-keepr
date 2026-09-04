-- Remove the dual-key credential-rotation log (issue #154). ADR 0005 replaced
-- the attested rotation subsystem with an append-only log of operator
-- rotations; credential rotation is deferred until after Go-Live, so the log,
-- its administration route, and its runbook are deleted. The two-slot bearer
-- keys (primary plus replacement) stay because both workers depend on them
-- for a gap-free key change. Per ADR 0008 this migration is folded into the
-- baseline at Go-Live.
--
-- Dropping the table also removes its sqlite_sequence row (the table used
-- AUTOINCREMENT), and dropping a table drops its triggers, but the triggers
-- are dropped explicitly first so the intent is visible in the file.

SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 2
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_2', '$')
END;

DROP TRIGGER guard_credential_rotation_log_update;
DROP TRIGGER guard_credential_rotation_log_delete;
DROP TABLE credential_rotation_log;

UPDATE catalogue_schema_state
SET migration_level = 3
WHERE singleton = 1;
