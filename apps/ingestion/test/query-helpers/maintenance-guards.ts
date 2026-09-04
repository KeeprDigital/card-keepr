// Real-D1 fixtures for repository guards after removal of transitional triggers.
export async function disableBackupTransitionTriggers(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS catalogue_backup_attempts_legal_transition"),
    database.prepare("DROP TRIGGER IF EXISTS catalogue_backup_verified_evidence_required"),
  ]);
}

export function seedVerifyingBackup(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_backup_attempts
    SET state = 'verifying', d1_bookmark = 'bookmark-guard',
      content_sha256 = ?, export_bytes = ?, schema_migration_level = ?,
      disposable_database_id = ?, restore_generation = ?,
      restore_phase = 'imported', manifest_key = ?, manifest_sha256 = ?
    WHERE idempotency_key = ?`);
}

export async function disableRecoveryTransitionTrigger(database: D1Database): Promise<void> {
  await database.prepare("DROP TRIGGER IF EXISTS catalogue_recovery_transition_is_legal").run();
}

export async function disableExportTransitionTriggers(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS catalogue_export_deletion_operation_guard"),
    database.prepare("DROP TRIGGER IF EXISTS catalogue_export_deletion_operation_transition_guard"),
    database.prepare("DROP TRIGGER IF EXISTS catalogue_export_maintenance_transition_guard"),
  ]);
}

export async function disableRecoveryHealthTrigger(database: D1Database): Promise<void> {
  await database.prepare("DROP TRIGGER IF EXISTS catalogue_recovery_health_remains_blocked").run();
}

export function resetMaintenanceOperation(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
    SET recovery_health = 'healthy', active_recovery_id = NULL,
      recovery_restore_guard = 'clear', active_ingestion_run_id = NULL,
      active_production_release_id = NULL, active_production_release_expires_at = NULL
    WHERE singleton = 1`);
}

export function failUnfinishedMaintenanceRecoveries(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_recovery_operations
    SET state = 'failed', failure_code = 'fixture_cleanup', failure_detail = 'fixture cleanup',
      failed_at = '2026-09-04T00:00:00.000Z'
    WHERE state IN ('preparing', 'restoring', 'validating', 'awaiting_acceptance')`);
}
