-- Issue #88 / ADR 0005: dual-key rotation replaces attested rotation.
--
-- The attested credential-rotation subsystem introduced by 0005 (reserved
-- rotation plans, single-use consumer-proof nonces, installed rotations, and
-- the operation-state generation counter they fenced) is deleted. Rotation is
-- now an operator procedure recorded in credential_rotation_log (0034). The
-- triggers that blocked ingestion, recovery, and catalogue reconciliation
-- while a plan was executing go first because they reference the tables;
-- the plan-finalization guard goes with its table.
SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 35
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_35', '$')
END;

DROP TRIGGER IF EXISTS block_ingestion_during_credential_execution;
DROP TRIGGER IF EXISTS block_recovery_during_credential_execution;
DROP TRIGGER IF EXISTS block_catalogue_reconciliation_during_credential_execution;
DROP TRIGGER IF EXISTS guard_credential_plan_finalization;

DROP TABLE credential_consumer_proof_uses;
DROP TABLE credential_rotations;
DROP TABLE credential_rotation_plans;

ALTER TABLE operation_state DROP COLUMN credential_rotation_generation;

UPDATE catalogue_schema_state
SET migration_level = 36
WHERE singleton = 1;
