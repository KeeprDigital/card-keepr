// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function readCatalogueRecoveryOperationsStateAcceptanceIdempotencyKey(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT state, acceptance_idempotency_key
     FROM catalogue_recovery_operations
     WHERE id = 'recovery-concurrent-accept'`);
}

export function countCatalogueRecoveryOperationsCount(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT COUNT(*) AS count FROM catalogue_recovery_operations WHERE id = 'recovery-raced'");
}

export function readCatalogueRecoveryOperationsStateFailureCode(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, failure_code FROM catalogue_recovery_operations
     WHERE id = 'recovery-paused'`);
}

export function dropCatalogueRecoveryOperationsAreNotDeleted(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER catalogue_recovery_operations_are_not_deleted");
}

export function deleteCatalogueRecoveryOperations(database: D1Database): D1PreparedStatement {
  return database.prepare("DELETE FROM catalogue_recovery_operations WHERE id = 'recovery-ambiguous'");
}

export function deleteCatalogueRecoveryOperationsForReplacementAcceptanceRehydratesJournalThroughReboundHTTPRoute(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`DELETE FROM catalogue_recovery_operations
     WHERE id IN ('recovery-route-rebound', 'recovery-ambiguous')`);
}

export function deleteCatalogueRecoveryOperationsForAcceptedJournalHydrationStaysBlockedAgainstWrongLocalCatalogue(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`DELETE FROM catalogue_recovery_operations
     WHERE id = 'recovery-accepted-wrong-local'`);
}

export function insertCatalogueBackupAttempts(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT OR IGNORE INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, d1_bookmark, started_at, completed_at,
       manifest_key, content_sha256, manifest_sha256, export_bytes,
       schema_migration_level, disposable_database_id, restore_generation,
       restore_phase
     ) VALUES (?, ?, ?, 'catrev_spine_000', 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'verified')`);
}

export function deleteCatalogueBackupRetention(database: D1Database): D1PreparedStatement {
  return database.prepare("DELETE FROM catalogue_backup_retention");
}

export function deleteCatalogueBackupAttempts(database: D1Database): D1PreparedStatement {
  return database.prepare("DELETE FROM catalogue_backup_attempts");
}

export function readCatalogueBackupAttemptsStateFailureCode(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, failure_code FROM catalogue_backup_attempts
     WHERE idempotency_key = 'backup-production-failure'`);
}

export function readCatalogueBackupAttemptsPresent(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT 1 AS present FROM catalogue_backup_attempts
     WHERE idempotency_key = 'backup-production-unlinked-after-failure'`);
}

export function readCatalogueBackupAttemptsPresentForBackupFailureReconstructsLiveSearchLeavesRecoveryDegraded(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT 1 AS present FROM catalogue_backup_attempts
     WHERE idempotency_key = 'backup-production-superseded-retry'`);
}

export function readCatalogueBackupAttemptsStateDisposableDatabaseId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, disposable_database_id, restore_generation, restore_phase
     FROM catalogue_backup_attempts WHERE idempotency_key = ?`);
}

export function createSyntheticLostExportTransition(database: D1Database): D1PreparedStatement {
  return database.prepare(`CREATE TRIGGER synthetic_lost_export_transition
     BEFORE UPDATE OF state ON catalogue_backup_attempts
     WHEN OLD.state = 'exporting' AND NEW.state = 'restoring_verification'
     BEGIN SELECT RAISE(ABORT, 'synthetic_lost_export_transition'); END`);
}

export function insertCatalogueBackupAttemptsForAuthenticatedStatusRouteExposesExactPendingPublicationAttemptResume(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, started_at, publication_ingestion_run_id
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, (
       SELECT ingestion_run_id FROM catalogue_revisions WHERE id = ?
     ))`);
}

export function insertCatalogueBackupAttemptsForBackupRetryRejectsSourceStateRevisionDigestBeforeWorkflow(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_backup_attempts (
         idempotency_key, request_json, owner_token, catalogue_revision_id,
         state, object_key, started_at, failure_code, failure_detail,
         completed_at, linked_attempt_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
}

export function countCatalogueBackupWorkflowRequestsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT count(*) AS count FROM catalogue_backup_workflow_requests
     WHERE idempotency_key LIKE 'retry-backup-source-%'
        OR idempotency_key = 'backup-unlinked-route'`);
}
