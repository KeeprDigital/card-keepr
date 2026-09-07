import { guardRehydratedBackupEvidenceStatement } from "./backup-evidence-repository";
import { type CatalogueStore, repositoryStatements, atomicRepositoryStatement } from "../shared";
export function enforceRestoreGuardStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`UPDATE operation_state SET recovery_health = 'blocked'
     WHERE singleton = 1 AND recovery_restore_guard = 'blocked'
       AND recovery_health <> 'blocked'`);
}

export function recoveryOperationStateStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(
    database,
  ).prepare(`SELECT catalogue.current_revision_id, operation.active_ingestion_run_id,
            operation.active_production_release_id,
            operation.active_production_release_expires_at,
            operation.recovery_health, operation.active_recovery_id
     FROM catalogue_state AS catalogue
     JOIN operation_state AS operation ON operation.singleton = 1
     WHERE catalogue.singleton = 1`);
}

export function guardRecoveryStartStatement(
  database: CatalogueStore,
  input: Readonly<{ expectedCurrentRevisionId: string; observedAt: string; linkedOperationId: string | null }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
           SELECT 1 FROM catalogue_state AS catalogue
           JOIN operation_state AS operation ON operation.singleton = 1
           WHERE catalogue.singleton = 1
             AND catalogue.current_revision_id = ?
             AND operation.active_ingestion_run_id IS NULL
             AND (operation.active_production_release_id IS NULL
               OR operation.active_production_release_expires_at <= ?)
             AND (
               (? IS NULL AND operation.recovery_health <> 'blocked'
                 AND operation.active_recovery_id IS NULL
                 AND NOT EXISTS(SELECT 1 FROM catalogue_backup_attempts WHERE state IN ('pending','exporting','restoring_verification','verifying')))
               OR (? IS NOT NULL AND operation.recovery_health = 'blocked'
                 AND operation.active_recovery_id = ?)
             )
         ) THEN 1 ELSE json_extract('invalid', '$') END`)
    .bind(
      input.expectedCurrentRevisionId,
      input.observedAt,
      input.linkedOperationId,
      input.linkedOperationId,
      input.linkedOperationId,
    );
}

export function insertRecoveryOperationStatement(
  database: CatalogueStore,
  input: Readonly<{
    recoveryId: string;
    method: "time_travel" | "replacement_database";
    requestJson: string;
    idempotencyKey: string;
    targetRevisionId: string;
    targetBookmark: string;
    targetDigest: string;
    backupAttemptId: string;
    linkedOperationId: string | null;
    expectedCurrentRevisionId: string;
    currentBookmark: string | null;
    catalogueDatabaseId: string;
    schema_migration_level: number;
    expected_evidenceJson: string;
    observedAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO catalogue_recovery_operations (
           id, state, method, request_json, idempotency_key,
           target_revision_id, target_bookmark, target_digest,
           source_backup_attempt_id, linked_operation_id,
           expected_current_revision_id, current_bookmark,
           original_database_id, expected_schema_migration_level,
           expected_verification_json, started_at
         ) VALUES (?, 'preparing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      input.recoveryId,
      input.method,
      input.requestJson,
      input.idempotencyKey,
      input.targetRevisionId,
      input.targetBookmark,
      input.targetDigest,
      input.backupAttemptId,
      input.linkedOperationId,
      input.expectedCurrentRevisionId,
      input.currentBookmark,
      input.catalogueDatabaseId,
      input.schema_migration_level,
      input.expected_evidenceJson,
      input.observedAt,
    );
}

export function reserveRecoveryOperationStatement(
  database: CatalogueStore,
  input: Readonly<{ recoveryId: string; observedAt: string; linkedOperationId: string | null }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
         SET recovery_health = 'blocked', active_recovery_id = ?,
             recovery_restore_guard = 'blocked'
         WHERE singleton = 1 AND active_ingestion_run_id IS NULL
           AND (active_production_release_id IS NULL OR active_production_release_expires_at <= ?)
           AND (
             (? IS NULL AND recovery_health <> 'blocked'
               AND active_recovery_id IS NULL
               AND NOT EXISTS(SELECT 1 FROM catalogue_backup_attempts WHERE state IN ('pending','exporting','restoring_verification','verifying')))
             OR (? IS NOT NULL AND recovery_health = 'blocked'
               AND active_recovery_id = ?)
           )`)
    .bind(
      input.recoveryId,
      input.observedAt,
      input.linkedOperationId,
      input.linkedOperationId,
      input.linkedOperationId,
    );
}

export function guardRecoveryReservationStatement(
  database: CatalogueStore,
  input: Readonly<{ recoveryId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN recovery_health = 'blocked'
             AND active_recovery_id = ?
           THEN 1 ELSE json_extract('invalid', '$') END
         FROM operation_state WHERE singleton = 1`)
    .bind(input.recoveryId);
}

export function completeRecoveryVerificationStatement(
  database: CatalogueStore,
  input: Readonly<{
    verificationJson: string;
    idempotencyKey: string;
    requestDigest: string;
    observedAt: string;
    recoveryId: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_recovery_operations
       SET state = 'awaiting_acceptance', verification_json = ?,
           verification_idempotency_key = ?,
           verification_request_digest = ?, verified_at = ?
       WHERE id = ? AND state = 'validating'
         AND verification_idempotency_key IS NULL`)
    .bind(input.verificationJson, input.idempotencyKey, input.requestDigest, input.observedAt, input.recoveryId);
}

export function recoveryCurrentRevisionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1");
}

export function guardRecoveryAcceptanceStatement(
  database: CatalogueStore,
  input: Readonly<{ recoveryId: string; target_revision_id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
           SELECT 1 FROM catalogue_recovery_operations AS recovery
           JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
           JOIN operation_state AS operation ON operation.singleton = 1
           WHERE recovery.id = ? AND recovery.state = 'awaiting_acceptance'
             AND recovery.acceptance_idempotency_key IS NULL
             AND recovery.target_revision_id = ?
             AND catalogue.current_revision_id = recovery.target_revision_id
             AND operation.recovery_health = 'blocked'
             AND operation.active_recovery_id = recovery.id
         ) THEN 1 ELSE json_extract('invalid', '$') END`)
    .bind(input.recoveryId, input.target_revision_id);
}

export function acceptRecoveryOperationStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string; requestDigest: string; observedAt: string; recoveryId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_recovery_operations
         SET state = 'accepted', acceptance_idempotency_key = ?,
             acceptance_request_digest = ?, accepted_at = ?
         WHERE id = ? AND state = 'awaiting_acceptance'`)
    .bind(input.idempotencyKey, input.requestDigest, input.observedAt, input.recoveryId);
}

export function confirmRecoveredCatalogueRevisionStatement(
  database: CatalogueStore,
  input: Readonly<{ target_revision_id: string; observedAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_state SET current_revision_id = ?, published_at = ?
         WHERE singleton = 1 AND current_revision_id = ?`)
    .bind(input.target_revision_id, input.observedAt, input.target_revision_id);
}

export function releaseAcceptedRecoveryStatement(
  database: CatalogueStore,
  input: Readonly<{ recoveryId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
         SET recovery_health = CASE WHEN recovery_health = 'blocked' AND EXISTS (
             SELECT 1 FROM catalogue_recovery_operations AS recovery
             WHERE recovery.id = operation_state.active_recovery_id
               AND recovery.state <> 'accepted'
           ) THEN json_extract('{}', 'recovery_not_accepted') ELSE 'healthy' END, active_recovery_id = NULL,
             recovery_restore_guard = 'clear'
         WHERE singleton = 1 AND recovery_health = 'blocked'
           AND active_recovery_id = ?`)
    .bind(input.recoveryId);
}

export function guardAcceptedRecoveryStatement(
  database: CatalogueStore,
  input: Readonly<{ recoveryId: string; idempotencyKey: string; requestDigest: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
           SELECT 1 FROM catalogue_recovery_operations AS recovery
           JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
           JOIN operation_state AS operation ON operation.singleton = 1
           WHERE recovery.id = ? AND recovery.state = 'accepted'
             AND recovery.acceptance_idempotency_key = ?
             AND recovery.acceptance_request_digest = ?
             AND catalogue.current_revision_id = recovery.target_revision_id
             AND operation.recovery_health = 'healthy'
             AND operation.active_recovery_id IS NULL
             AND operation.recovery_restore_guard = 'clear'
         ) THEN 1 ELSE json_extract('invalid', '$') END`)
    .bind(input.recoveryId, input.idempotencyKey, input.requestDigest);
}

export function recoveryGuardStateStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT recovery_health, active_recovery_id, recovery_restore_guard
     FROM operation_state WHERE singleton = 1`);
}

export function guardRecoveryReleaseStatement(
  database: CatalogueStore,
  input: Readonly<{ id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN recovery_health = 'blocked'
             AND active_recovery_id = ?
             AND recovery_restore_guard = 'blocked'
           THEN 1 ELSE json_extract('invalid', '$') END
         FROM operation_state WHERE singleton = 1`)
    .bind(input.id);
}

export function clearBlockedRecoveryStatement(
  database: CatalogueStore,
  input: Readonly<{ id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
         SET recovery_health = CASE WHEN recovery_health = 'blocked' AND EXISTS (
             SELECT 1 FROM catalogue_recovery_operations AS recovery
             WHERE recovery.id = operation_state.active_recovery_id
               AND recovery.state <> 'accepted'
           ) THEN json_extract('{}', 'recovery_not_accepted') ELSE 'healthy' END, active_recovery_id = NULL,
             recovery_restore_guard = 'clear'
         WHERE singleton = 1 AND recovery_health = 'blocked'
           AND active_recovery_id = ?
           AND recovery_restore_guard = 'blocked'`)
    .bind(input.id);
}

export function guardHealthyRecoveryStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT CASE WHEN recovery_health = 'healthy'
             AND active_recovery_id IS NULL
             AND recovery_restore_guard = 'clear'
           THEN 1 ELSE json_extract('invalid', '$') END
         FROM operation_state WHERE singleton = 1`);
}

export function verifiedBackupSchemaEvidenceStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT backup.catalogue_revision_id, backup.d1_bookmark,
            backup.manifest_sha256, backup.schema_migration_level,
            schema_state.migration_level AS current_schema_migration_level
     FROM catalogue_backup_attempts AS backup
     JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
     WHERE backup.idempotency_key = ? AND backup.state = 'verified'`)
    .bind(input.idempotency_key);
}

export function recoveryEvidenceCurrentRevisionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1");
}

export function verifiedRecoveryBackupStatement(
  database: CatalogueStore,
  input: Readonly<{ backupAttemptId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT idempotency_key, catalogue_revision_id, object_key, d1_bookmark,
            manifest_key, manifest_sha256, content_sha256, export_bytes,
            schema_migration_level, disposable_database_id,
            restore_generation, restore_phase, completed_at
     FROM catalogue_backup_attempts AS backup
     JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
     WHERE backup.idempotency_key = ? AND backup.state = 'verified'
       AND backup.schema_migration_level = schema_state.migration_level`)
    .bind(input.backupAttemptId);
}

export function recoveryBackupSchemaStatement(
  database: CatalogueStore,
  input: Readonly<{ backupAttemptId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT backup.schema_migration_level, schema_state.migration_level
       FROM catalogue_backup_attempts AS backup
       JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
       WHERE backup.idempotency_key = ? AND backup.state = 'verified'`)
    .bind(input.backupAttemptId);
}

export function insertRecoveryJournalStatement(
  database: CatalogueStore,
  input: Readonly<{
    id: string;
    state: string;
    method: "time_travel" | "replacement_database";
    request_json: string;
    idempotency_key: string;
    target_revision_id: string;
    target_bookmark: string;
    target_digest: string;
    source_backup_attempt_id: string;
    linked_operation_id: string | null;
    expected_current_revision_id: string;
    current_bookmark: string | null;
    restored_bookmark: string | null;
    undo_bookmark: string | null;
    original_database_id: string;
    restored_database_id: string | null;
    retained_database_id: string | null;
    expected_schema_migration_level: number;
    expected_verification_json: string;
    verification_json: string | null;
    verification_idempotency_key: string | null;
    verification_request_digest: string | null;
    acceptance_idempotency_key: string | null;
    acceptance_request_digest: string | null;
    started_at: string;
    restored_at: string | null;
    verified_at: string | null;
    accepted_at: string | null;
    failure_code: string | null;
    failure_detail: string | null;
    failed_at: string | null;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO catalogue_recovery_operations (
       id, state, method, request_json, idempotency_key,
       target_revision_id, target_bookmark, target_digest,
       source_backup_attempt_id, linked_operation_id,
       expected_current_revision_id, current_bookmark, restored_bookmark,
       undo_bookmark, original_database_id, restored_database_id,
       retained_database_id, expected_schema_migration_level,
       expected_verification_json, verification_json,
       verification_idempotency_key, verification_request_digest,
       acceptance_idempotency_key, acceptance_request_digest,
       started_at, restored_at, verified_at, accepted_at,
       failure_code, failure_detail, failed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      input.id,
      input.state,
      input.method,
      input.request_json,
      input.idempotency_key,
      input.target_revision_id,
      input.target_bookmark,
      input.target_digest,
      input.source_backup_attempt_id,
      input.linked_operation_id,
      input.expected_current_revision_id,
      input.current_bookmark,
      input.restored_bookmark,
      input.undo_bookmark,
      input.original_database_id,
      input.restored_database_id,
      input.retained_database_id,
      input.expected_schema_migration_level,
      input.expected_verification_json,
      input.verification_json,
      input.verification_idempotency_key,
      input.verification_request_digest,
      input.acceptance_idempotency_key,
      input.acceptance_request_digest,
      input.started_at,
      input.restored_at,
      input.verified_at,
      input.accepted_at,
      input.failure_code,
      input.failure_detail,
      input.failed_at,
    );
}

export function restoreRecoveryReservationStatement(
  database: CatalogueStore,
  input: Readonly<{ id: string; linked_operation_id: string | null }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
     SET recovery_health = 'blocked', active_recovery_id = ?,
         recovery_restore_guard = 'blocked'
     WHERE singleton = 1 AND active_ingestion_run_id IS NULL
       AND (active_recovery_id IS NULL OR active_recovery_id = ?
         OR active_recovery_id = ?)`)
    .bind(input.id, input.id, input.linked_operation_id);
}

export function rehydratedBackupStateStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT state FROM catalogue_backup_attempts WHERE idempotency_key = ?")
    .bind(input.idempotency_key);
}

export function startRehydratedBackupExportStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("UPDATE catalogue_backup_attempts SET state = 'exporting' WHERE idempotency_key = ? AND state = 'pending'")
    .bind(input.idempotency_key);
}

export function restoreRehydratedBackupEvidenceStatement(
  database: CatalogueStore,
  input: Readonly<{
    d1_bookmark: string;
    manifest_key: string;
    content_sha256: string;
    manifest_sha256: string;
    export_bytes: number;
    schema_migration_level: number;
    disposable_database_id: string;
    restore_generation: number;
    idempotency_key: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
       SET state = 'restoring_verification', d1_bookmark = ?,
           manifest_key = ?, content_sha256 = ?, manifest_sha256 = ?,
           export_bytes = ?, schema_migration_level = ?,
           disposable_database_id = ?, restore_generation = ?,
           restore_phase = 'prepared'
       WHERE idempotency_key = ? AND state = 'exporting'`)
    .bind(
      input.d1_bookmark,
      input.manifest_key,
      input.content_sha256,
      input.manifest_sha256,
      input.export_bytes,
      input.schema_migration_level,
      input.disposable_database_id,
      input.restore_generation,
      input.idempotency_key,
    );
}

export function startRehydratedBackupVerificationStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
       SET state = 'verifying', restore_phase = 'imported'
       WHERE idempotency_key = ? AND state = 'restoring_verification'`)
    .bind(input.idempotency_key);
}

export function completeRehydratedBackupStatement(
  database: CatalogueStore,
  input: Readonly<{ completed_at: string; idempotency_key: string }>,
): D1PreparedStatement {
  const statement = repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
       SET state = 'verified', completed_at = ?, restore_phase = 'verified'
       WHERE idempotency_key = ? AND state = 'verifying'`)
    .bind(input.completed_at, input.idempotency_key);
  return atomicRepositoryStatement(database, {
    statement,
    before: [guardRehydratedBackupEvidenceStatement(database, input)],
  });
}

export function linkedRecoveryOperationStatement(
  database: CatalogueStore,
  input: Readonly<{ linkedOperationId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT id FROM catalogue_recovery_operations
       WHERE linked_operation_id = ? LIMIT 1`)
    .bind(input.linkedOperationId);
}

export function startRecoveryRestoreStatement(
  database: CatalogueStore,
  input: Readonly<{ recoveryId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("UPDATE catalogue_recovery_operations SET state = 'restoring' WHERE id = ? AND state = 'preparing'")
    .bind(input.recoveryId);
}

export function startRecoveryValidationStatement(
  database: CatalogueStore,
  input: Readonly<{
    restoredBookmark: string;
    undoBookmark: string | null;
    restoredDatabaseId: string;
    retainedDatabaseId: string | null;
    observedAt: string;
    recoveryId: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_recovery_operations
     SET state = 'validating', restored_bookmark = ?, undo_bookmark = ?,
         restored_database_id = ?, retained_database_id = ?, restored_at = ?
     WHERE id = ? AND state = 'restoring'`)
    .bind(
      input.restoredBookmark,
      input.undoBookmark,
      input.restoredDatabaseId,
      input.retainedDatabaseId,
      input.observedAt,
      input.recoveryId,
    );
}

export function failRecoveryOperationStatement(
  database: CatalogueStore,
  input: Readonly<{ code: string; observedAt: string; recoveryId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_recovery_operations
     SET state = 'failed', failure_code = ?, failure_detail = ?, failed_at = ?
     WHERE id = ? AND state IN (
       'preparing', 'restoring', 'validating', 'awaiting_acceptance'
     )`)
    .bind(input.code, "Catalogue recovery failed; mutation remains blocked.", input.observedAt, input.recoveryId);
}

export function recoveryOperationByIdStatement(
  database: CatalogueStore,
  input: Readonly<{ recoveryId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT * FROM catalogue_recovery_operations WHERE id = ?")
    .bind(input.recoveryId);
}

export function recoveryOperationByIdempotencyStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT * FROM catalogue_recovery_operations WHERE idempotency_key = ?")
    .bind(input.idempotencyKey);
}

/** Classify only work present in this snapshot. Newer lost operations are not invented. */
export function classifyRestoredWorkStatements(database: CatalogueStore, recoveryId: string): D1PreparedStatement[] {
  const sql = repositoryStatements(database);
  return [
    sql
      .prepare(`INSERT OR IGNORE INTO catalogue_recovery_collection_classifications
      SELECT ?,r.id,c.state,CASE WHEN EXISTS(SELECT 1 FROM ingestion_collection_completions x WHERE x.ingestion_run_id=r.id)
      OR c.state IN ('published','failed','rejected','terminated','unchanged') THEN 'retained_source' ELSE 'abandoned_after_restore' END
      FROM ingestion_runs r JOIN ingestion_run_current c ON c.ingestion_run_id=r.id`)
      .bind(recoveryId),
    sql
      .prepare(`DELETE FROM ingestion_collection_reservations WHERE ingestion_run_id IN (
      SELECT ingestion_run_id FROM catalogue_recovery_collection_classifications WHERE recovery_id=? AND classification='abandoned_after_restore')`)
      .bind(recoveryId),
    sql
      .prepare(`INSERT OR IGNORE INTO catalogue_recovery_work_classifications
      SELECT ?,o.id,o.state,o.generation,CASE
      WHEN EXISTS(SELECT 1 FROM game_candidates c WHERE c.preparation_id=o.id AND c.state='published') THEN 'published_retained'
      WHEN o.state IN ('failed','abandoned') THEN 'terminal_retained' ELSE 'abandoned_after_restore' END
      FROM reconciliation_operations o WHERE o.supported_game IS NOT NULL`)
      .bind(recoveryId),
    sql
      .prepare(`UPDATE game_publication_operations SET state='failed',failure_code='catalogue_recovered',generation=generation+1
      WHERE state NOT IN ('published','failed') AND candidate_id IN (
        SELECT c.id FROM game_candidates c JOIN catalogue_recovery_work_classifications w ON w.preparation_id=c.preparation_id
        WHERE w.recovery_id=? AND w.classification='abandoned_after_restore')`)
      .bind(recoveryId),
    sql
      .prepare(`UPDATE game_candidates SET state='abandoned',generation=generation+1
      WHERE state NOT IN ('published','failed','abandoned','rejected','expired') AND preparation_id IN (
        SELECT preparation_id FROM catalogue_recovery_work_classifications WHERE recovery_id=? AND classification='abandoned_after_restore')`)
      .bind(recoveryId),
    sql
      .prepare(`UPDATE reconciliation_operations SET state='abandoned',generation=generation+1,failure_code='catalogue_recovered'
      WHERE id IN (SELECT preparation_id FROM catalogue_recovery_work_classifications WHERE recovery_id=?
        AND classification='abandoned_after_restore') AND state NOT IN ('failed','abandoned')`)
      .bind(recoveryId),
    sql
      .prepare(`DELETE FROM game_candidate_slots WHERE preparation_id IN (
      SELECT preparation_id FROM catalogue_recovery_work_classifications WHERE recovery_id=? AND classification='abandoned_after_restore')`)
      .bind(recoveryId),
  ];
}
export function restoredWorkClassificationsStatement(database: CatalogueStore, recoveryId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT classification,count(*) AS operations
    FROM catalogue_recovery_work_classifications WHERE recovery_id=? GROUP BY classification`)
    .bind(recoveryId);
}

export function restoredCollectionClassificationsStatement(database: CatalogueStore, recoveryId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT classification,count(*) AS collections
    FROM catalogue_recovery_collection_classifications WHERE recovery_id=? GROUP BY classification`)
    .bind(recoveryId);
}
