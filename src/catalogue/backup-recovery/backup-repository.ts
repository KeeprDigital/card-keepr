import { guardCompletingBackupEvidenceStatement } from "./backup-evidence-repository";
import { type CatalogueStore, repositoryStatements, atomicRepositoryStatement } from "../shared";
export type BackupAttemptEvidenceRow = Readonly<{
  idempotency_key: string;
  request_json: string;
  catalogue_revision_id: string;
  state: string;
  object_key: string;
  d1_bookmark: string | null;
  content_sha256: string | null;
  export_bytes: number | null;
  failure_code: string | null;
  failure_detail: string | null;
  started_at: string;
  completed_at: string | null;
  linked_attempt_id: string | null;
  manifest_sha256: string | null;
  disposable_database_id: string | null;
  restore_generation: number;
  restore_phase: string | null;
  publication_operation_id: string | null;
  publication_ingestion_run_id: string | null;
}>;

export function backupAttemptEvidenceStatement(database: CatalogueStore, idempotencyKey: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT idempotency_key, request_json, catalogue_revision_id, state,
            object_key, d1_bookmark, content_sha256, export_bytes,
            failure_code, failure_detail, started_at, completed_at,
            linked_attempt_id, manifest_sha256, disposable_database_id,
            restore_generation, restore_phase, publication_operation_id, publication_ingestion_run_id
     FROM catalogue_backup_attempts WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey);
}

export type RestorePhaseTransitionInput = {
  idempotencyKey: string;
  ownerToken: string;
  from: string;
  to: string;
};

export function restorePhaseTransitionStatement(
  database: CatalogueStore,
  input: RestorePhaseTransitionInput,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `UPDATE catalogue_backup_attempts SET restore_phase = ?
     WHERE idempotency_key = ? AND owner_token = ?
       AND state = 'restoring_verification' AND restore_phase = ?`,
    )
    .bind(input.to, input.idempotencyKey, input.ownerToken, input.from);
}

export function backupWorkflowIdentityStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT workflow_instance_id FROM catalogue_backup_workflow_requests
     WHERE idempotency_key = ?`)
    .bind(input.idempotencyKey);
}

export function knownCatalogueRevisionStatement(
  database: CatalogueStore,
  input: Readonly<{ catalogueRevisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT 1 AS present FROM catalogue_state
     WHERE singleton = 1 AND current_revision_id = ?
     UNION ALL
     SELECT 1 AS present FROM catalogue_revisions WHERE id = ?
     LIMIT 1`)
    .bind(input.catalogueRevisionId, input.catalogueRevisionId);
}

export function revisionBackupHistoryStatement(
  database: CatalogueStore,
  input: Readonly<{ catalogueRevisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT idempotency_key FROM catalogue_backup_attempts
     WHERE catalogue_revision_id = ?
     ORDER BY started_at DESC, idempotency_key DESC`)
    .bind(input.catalogueRevisionId);
}

export function unrecoveredBackupFailureStatement(
  database: CatalogueStore,
  input: Readonly<{ expectedCurrentRevisionId: string; idempotencyKey: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT 1 AS required
       FROM catalogue_backup_attempts AS failed
       WHERE failed.catalogue_revision_id = ?
         AND failed.state = 'failed'
         AND failed.idempotency_key <> ?
         AND NOT EXISTS (
           SELECT 1 FROM catalogue_backup_attempts AS recovered
           WHERE recovered.catalogue_revision_id = failed.catalogue_revision_id
             AND recovered.state = 'verified'
             AND recovered.completed_at >= failed.completed_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM catalogue_backup_attempts AS reserved
           WHERE reserved.idempotency_key = ?
             AND reserved.publication_ingestion_run_id IS NOT NULL
         )
       LIMIT 1`)
    .bind(input.expectedCurrentRevisionId, input.idempotencyKey, input.idempotencyKey);
}

export function backupCurrentRevisionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1");
}

export function backupRetryChildStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT idempotency_key FROM catalogue_backup_attempts
     WHERE linked_attempt_id = ?
     UNION ALL
     SELECT idempotency_key FROM catalogue_backup_workflow_requests
     WHERE linked_attempt_id = ?
     LIMIT 1`)
    .bind(input.idempotency_key, input.idempotency_key);
}

export function insertPendingBackupStatement(
  database: CatalogueStore,
  input: Readonly<{
    idempotencyKey: string;
    requestJson: string;
    ownerToken: string;
    expectedCurrentRevisionId: string;
    objectKey: string;
    observedAt: string;
    linkedAttemptId: string | null;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH intended AS (SELECT CASE WHEN ?7 IS NOT NULL THEN
       (SELECT publication_operation_id FROM catalogue_backup_attempts WHERE idempotency_key=?7 AND catalogue_revision_id=?4)
       ELSE json_extract(?2,'$.publication_operation_id') END AS operation_id)
     INSERT OR IGNORE INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, started_at, linked_attempt_id, publication_operation_id, publication_ingestion_run_id
     ) SELECT ?1,?2,?3,?4,'pending',?5,?6,?7,operation_id,
       (SELECT candidate.ingestion_run_id FROM game_publication_operations publication
        JOIN game_candidates candidate ON candidate.id=publication.candidate_id WHERE publication.id=operation_id)
     FROM intended WHERE CASE
       WHEN ?7 IS NOT NULL AND NOT EXISTS(SELECT 1 FROM catalogue_backup_attempts
         WHERE idempotency_key=?7 AND catalogue_revision_id=?4)
         THEN json_extract('{}','backup_acceptance_metadata_mismatch')
       WHEN operation_id IS NOT json_extract(?2,'$.publication_operation_id')
         THEN json_extract('{}','backup_acceptance_metadata_mismatch')
       WHEN operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM game_publication_operations
         WHERE id=operation_id AND state='published' AND resulting_revision_id=?4)
         THEN json_extract('{}','backup_acceptance_metadata_mismatch')
       WHEN operation_id IS NULL AND EXISTS(SELECT 1 FROM catalogue_revisions WHERE id=?4 AND publication_operation_id IS NOT NULL)
         THEN json_extract('{}','backup_acceptance_metadata_mismatch')
       ELSE 1 END`)
    .bind(
      input.idempotencyKey,
      input.requestJson,
      input.ownerToken,
      input.expectedCurrentRevisionId,
      input.objectKey,
      input.observedAt,
      input.linkedAttemptId,
    );
}

export function backupAttemptWithRetentionStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT request_json, owner_token, publication_operation_id, state, catalogue_revision_id, object_key,
            d1_bookmark, failure_code, failure_detail, manifest_key,
            content_sha256, manifest_sha256, export_bytes,
            schema_migration_level, linked_attempt_id,
            publication_ingestion_run_id, disposable_database_id,
            restore_generation, restore_phase, retention.newest_success,
            retention.retain_until
     FROM catalogue_backup_attempts AS attempt
     LEFT JOIN catalogue_backup_retention AS retention
       ON retention.attempt_id = attempt.idempotency_key
     WHERE attempt.idempotency_key = ?`)
    .bind(input.idempotencyKey);
}

export function linkedBackupAttemptStatement(
  database: CatalogueStore,
  input: Readonly<{ linkedAttemptId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT idempotency_key FROM catalogue_backup_attempts
       WHERE linked_attempt_id = ? LIMIT 1`)
    .bind(input.linkedAttemptId);
}

export function backupOperationStateStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT catalogue.current_revision_id,
            operation.active_ingestion_run_id,
            operation.recovery_health, operation.active_recovery_id, operation.recovery_restore_guard
     FROM catalogue_state AS catalogue
     JOIN operation_state AS operation ON operation.singleton = 1
     WHERE catalogue.singleton = 1`);
}

export function guardPendingBackupStartStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string; ownerToken: string; publicationOwned: 0 | 1 }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
             SELECT 1 FROM catalogue_backup_attempts AS attempt
             JOIN operation_state AS operation ON operation.singleton = 1
             WHERE attempt.idempotency_key = ? AND attempt.owner_token = ?
               AND attempt.state = 'pending'
               AND (? = 1 OR operation.active_ingestion_run_id IS NULL)
               AND operation.recovery_health <> 'blocked'
               AND NOT EXISTS (
                 SELECT 1 FROM catalogue_backup_attempts AS active
                 WHERE active.idempotency_key <> attempt.idempotency_key
                   AND active.state IN (
                     'exporting', 'restoring_verification', 'verifying'
                   )
               )
           ) THEN 1 ELSE json_extract('invalid', '$') END`)
    .bind(input.idempotencyKey, input.ownerToken, input.publicationOwned);
}

export function startBackupExportStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string; ownerToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts SET state = 'exporting'
           WHERE idempotency_key = ? AND owner_token = ? AND state = 'pending'`)
    .bind(input.idempotencyKey, input.ownerToken);
}

export function reserveBackupOperationStatement(
  database: CatalogueStore,
  input: Readonly<{ publicationOwned: 0 | 1; native?: boolean }>,
): D1PreparedStatement {
  if (input.native) return repositoryStatements(database).prepare("SELECT 1");
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
           SET recovery_health = CASE WHEN ? = 1 THEN 'degraded' ELSE 'blocked' END
           WHERE singleton = 1
             AND (? = 1 OR active_ingestion_run_id IS NULL)
             AND recovery_health <> 'blocked'`)
    .bind(input.publicationOwned, input.publicationOwned);
}

export function blockBackupRestoreStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`UPDATE operation_state SET recovery_restore_guard = 'blocked'
           WHERE singleton = 1 AND recovery_restore_guard = 'clear'`);
}

export function clearBackupRestoreStatement(database: CatalogueStore, native = false): D1PreparedStatement {
  return repositoryStatements(
    database,
  ).prepare(`UPDATE operation_state SET recovery_restore_guard = 'clear'${native ? ", recovery_health = 'healthy'" : ""}
             WHERE singleton = 1 AND recovery_restore_guard = 'blocked'
               AND active_recovery_id IS NULL`);
}

export function guardBackupVerificationStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string; ownerToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
             SELECT 1 FROM catalogue_backup_attempts
             WHERE idempotency_key = ? AND owner_token = ?
               AND state = 'verifying'
           ) THEN 1 ELSE json_extract('invalid', '$') END`)
    .bind(input.idempotencyKey, input.ownerToken);
}

export function completeBackupStatement(
  database: CatalogueStore,
  input: Readonly<{
    bookmark: string;
    observedAt: string;
    manifestKey: string;
    manifestSha256: string;
    idempotencyKey: string;
    ownerToken: string;
  }>,
): D1PreparedStatement {
  const statement = repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
           SET state = 'verified', d1_bookmark = ?, completed_at = ?,
               manifest_key = ?, manifest_sha256 = ?,
               restore_phase = 'verified'
           WHERE idempotency_key = ? AND owner_token = ?
             AND state = 'verifying'`)
    .bind(
      input.bookmark,
      input.observedAt,
      input.manifestKey,
      input.manifestSha256,
      input.idempotencyKey,
      input.ownerToken,
    );
  return atomicRepositoryStatement(database, {
    statement,
    before: [guardCompletingBackupEvidenceStatement(database, input)],
  });
}

export function datePreviousBackupRetentionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`UPDATE catalogue_backup_retention
           SET newest_success = 0,
               retain_until = (
                 SELECT strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+90 days')
                 FROM catalogue_backup_attempts
                 WHERE idempotency_key = catalogue_backup_retention.attempt_id
               )
           WHERE newest_success = 1`);
}

export function retainNewestBackupStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO catalogue_backup_retention (
             attempt_id, newest_success, retain_until, policy
           ) VALUES (?, 1, NULL, 'newest-indefinite-and-dated-90-days')`)
    .bind(input.idempotencyKey);
}

export function restoreHealthyBackupStateStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(
    database,
  ).prepare(`UPDATE operation_state SET recovery_health = CASE WHEN recovery_health = 'blocked' AND EXISTS (
             SELECT 1 FROM catalogue_recovery_operations AS recovery
             WHERE recovery.id = operation_state.active_recovery_id
               AND recovery.state <> 'accepted'
           ) THEN json_extract('{}', 'recovery_not_accepted') ELSE 'healthy' END
           WHERE singleton = 1
             AND recovery_health IN ('blocked', 'degraded')`);
}

export function prepareBackupRestoreTargetStatement(
  database: CatalogueStore,
  input: Readonly<{
    disposableDatabaseId: string;
    nextGeneration: number;
    idempotencyKey: string;
    ownerToken: string;
    previousGeneration: number;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
     SET disposable_database_id = ?, restore_generation = ?,
         restore_phase = 'prepared'
     WHERE idempotency_key = ? AND owner_token = ?
       AND state = 'restoring_verification' AND restore_generation = ?`)
    .bind(
      input.disposableDatabaseId,
      input.nextGeneration,
      input.idempotencyKey,
      input.ownerToken,
      input.previousGeneration,
    );
}

export function startBackupVerificationStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string; ownerToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
     SET state = 'verifying', restore_phase = 'imported'
     WHERE idempotency_key = ? AND owner_token = ?
       AND state = 'restoring_verification' AND restore_phase = 'importing'`)
    .bind(input.idempotencyKey, input.ownerToken);
}

export function completeBackupExportStatement(
  database: CatalogueStore,
  input: Readonly<{
    bookmark: string;
    contentSha256: string;
    exportBytes: number;
    schemaMigrationLevel: number;
    idempotencyKey: string;
    ownerToken: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
     SET state = 'restoring_verification', d1_bookmark = ?,
         content_sha256 = ?, export_bytes = ?, schema_migration_level = ?
     WHERE idempotency_key = ? AND owner_token = ? AND state = 'exporting'`)
    .bind(
      input.bookmark,
      input.contentSha256,
      input.exportBytes,
      input.schemaMigrationLevel,
      input.idempotencyKey,
      input.ownerToken,
    );
}

export function degradeActiveBackupStateStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string; ownerToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state SET recovery_health = CASE WHEN recovery_health = 'blocked' AND EXISTS (
             SELECT 1 FROM catalogue_recovery_operations AS recovery
             WHERE recovery.id = operation_state.active_recovery_id
               AND recovery.state <> 'accepted'
           ) THEN json_extract('{}', 'recovery_not_accepted') ELSE 'degraded' END
       WHERE singleton = 1 AND recovery_health = 'blocked'
         AND EXISTS (
           SELECT 1 FROM catalogue_backup_attempts
           WHERE idempotency_key = ? AND owner_token = ?
             AND state IN ('exporting', 'restoring_verification', 'verifying')
         )`)
    .bind(input.idempotencyKey, input.ownerToken);
}

export function failOwnedActiveBackupStatement(
  database: CatalogueStore,
  input: Readonly<{ detail: string; completedAt: string; idempotencyKey: string; ownerToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
       SET state = 'failed', failure_code = 'backup_failed',
           failure_detail = ?, completed_at = ?
       WHERE idempotency_key = ? AND owner_token = ?
         AND state NOT IN ('verified', 'failed')`)
    .bind(input.detail, input.completedAt, input.idempotencyKey, input.ownerToken);
}

export function failOwnedBackupStatement(
  database: CatalogueStore,
  input: Readonly<{ code: string; detail: string; completedAt: string; idempotencyKey: string; ownerToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_attempts
     SET state = 'failed', failure_code = ?, failure_detail = ?, completed_at = ?
     WHERE idempotency_key = ? AND owner_token = ?
       AND state NOT IN ('verified', 'failed')`)
    .bind(input.code, input.detail, input.completedAt, input.idempotencyKey, input.ownerToken);
}

export function backupSchemaMigrationLevelStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(
    "SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1",
  );
}

export function fenceCompositionSnapshotStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`UPDATE operation_state SET recovery_health='blocked'
    WHERE singleton=1 AND active_recovery_id IS NULL AND recovery_restore_guard='blocked'`);
}

export function nativeBackupRevisionStatement(database: CatalogueStore, revision: string) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN accepted.state='published' AND accepted.resulting_revision_id=revision.id
      THEN accepted.id ELSE json_extract('{}','backup_acceptance_metadata_mismatch') END AS publication_operation_id,
    revision.id AS catalogue_revision_id,revision.content_digest AS composition_digest
    FROM catalogue_revisions revision LEFT JOIN catalogue_acceptance_head head ON head.singleton=1
    LEFT JOIN game_publication_operations accepted ON accepted.id=head.publication_operation_id
    WHERE revision.id=? AND revision.publication_operation_id IS NOT NULL`)
    .bind(revision);
}

export function catalogueMutationFenceStatement(database: CatalogueStore) {
  return repositoryStatements(database).prepare(`SELECT recovery_health,recovery_restore_guard,active_recovery_id
    FROM operation_state WHERE singleton=1`);
}

export function nativeBackupSnapshotFenceStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare(`SELECT b.owner_token,o.active_recovery_id,o.recovery_restore_guard,
    f.owner_token AS search_owner_token,f.state AS search_state
    FROM catalogue_backup_attempts b JOIN operation_state o ON o.singleton=1 JOIN card_search_fts_state f ON f.singleton=1
    WHERE b.idempotency_key=? AND b.publication_operation_id IS NOT NULL AND b.state='exporting'
    AND NOT EXISTS(SELECT 1 FROM catalogue_backup_attempts other WHERE other.idempotency_key<>b.idempotency_key
      AND other.state IN ('exporting','restoring_verification','verifying'))`)
    .bind(id);
}
