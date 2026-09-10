import { acceptedRevisionBackupSql } from "./accepted-backup-repository";
import {
  atomicRepositoryStatement,
  administrationOutcomeGuardStatement,
  type CatalogueStore,
  repositoryStatements,
  SPINE_REVISION_ID,
} from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function preparedProductionReleaseStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT operation, request_json, response_json FROM administration_idempotency
     WHERE idempotency_key = ?`)
    .bind(key);
}

export function recordPreparedProductionReleaseStatement(
  database: CatalogueStore,
  input: Readonly<{ key: string; requestJson: string; responseJson: string; createdAt: string }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO administration_idempotency (
           idempotency_key, operation, request_json, response_json,
           http_status, outcome, created_at
         ) VALUES (?, 'prepare_production_release', ?, ?, 201, 'success', ?)`)
      .bind(input.key, input.requestJson, input.responseJson, input.createdAt),
    after: [administrationOutcomeGuardStatement(database, input.key)],
  });
}

// Bootstrap Mode (issue #141): the catalogue is provably empty, so no backup,
// bookmark, retained window, or smoke target can exist. The gate keeps every
// data-independent check and additionally proves emptiness, so a bootstrap
// plan is refused the moment a Catalogue Revision has been published.
export function bootstrapGate(
  database: CatalogueStore,
  plan: Readonly<{ expected_migration_level: number }>,
  observedAt: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM catalogue_state AS catalogue
       JOIN operation_state AS operation ON operation.singleton = 1
       JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
       WHERE catalogue.singleton = 1
         AND catalogue.current_revision_id = ?
         AND NOT EXISTS (SELECT 1 FROM catalogue_revisions)
         AND schema_state.migration_level = ?
         AND operation.active_ingestion_run_id IS NULL
         AND (operation.active_production_release_id IS NULL
           OR operation.active_production_release_expires_at <= ?)
         AND operation.recovery_health = 'healthy' AND operation.active_recovery_id IS NULL
     ) THEN 1 ELSE json_extract('invalid', '$') END`,
    )
    .bind(SPINE_REVISION_ID, plan.expected_migration_level, observedAt);
}

export function populatedGate(
  database: CatalogueStore,
  plan: Readonly<{
    expected_migration_level: number;
    expected_current_revision_id: string;
    recovery_backup_attempt_id: string;
    recovery_bookmark: string;
    smoke_targets: Readonly<{ stale_revision_id: string }>;
    retained_revision_evidence: readonly Readonly<{ revision_id: string }>[];
    replacement_handoff: null | Readonly<{
      recovery_id: string;
      target_revision_id: string;
      target_digest: string;
      replacement_database_id: string;
      retained_database_id: string;
    }>;
  }>,
  observedAt: string,
): D1PreparedStatement {
  const replacement = plan.replacement_handoff;
  const recoveryGate =
    replacement === null
      ? `operation.recovery_health = 'healthy' AND operation.active_recovery_id IS NULL`
      : `operation.recovery_health = 'blocked' AND operation.active_recovery_id = ?
       AND EXISTS (SELECT 1 FROM catalogue_recovery_operations AS recovery
         WHERE recovery.id = ? AND recovery.state = 'awaiting_acceptance'
           AND recovery.method = 'replacement_database'
           AND recovery.target_revision_id = ? AND recovery.target_digest = ?
           AND recovery.restored_database_id = ? AND recovery.retained_database_id = ?
           AND recovery.verification_json IS NOT NULL)`;
  const gateBindings =
    replacement === null
      ? []
      : [
          replacement.recovery_id,
          replacement.recovery_id,
          replacement.target_revision_id,
          replacement.target_digest,
          replacement.replacement_database_id,
          replacement.retained_database_id,
        ];
  const retainedRevisionIds = plan.retained_revision_evidence.map((item) => item.revision_id);
  return repositoryStatements(database)
    .prepare(
      `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM catalogue_state AS catalogue
       JOIN operation_state AS operation ON operation.singleton = 1
       JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
       WHERE catalogue.singleton = 1
         AND catalogue.current_revision_id = ?
         AND schema_state.migration_level = ?
         AND operation.active_ingestion_run_id IS NULL
         AND (operation.active_production_release_id IS NULL
           OR operation.active_production_release_expires_at <= ?)
         AND ${recoveryGate}
         AND EXISTS (SELECT 1 FROM catalogue_backup_attempts AS backup
           WHERE backup.idempotency_key = ? AND backup.catalogue_revision_id = ?
             AND backup.state = 'verified' AND backup.d1_bookmark = ?
             AND backup.manifest_sha256 IS NOT NULL
             AND ${acceptedRevisionBackupSql("backup.catalogue_revision_id")})
         AND 3 = (WITH RECURSIVE retained(revision_id,depth) AS (
           SELECT catalogue.current_revision_id,0 UNION ALL
           SELECT revision.expected_previous_revision_id,retained.depth+1
           FROM retained JOIN catalogue_revisions AS revision ON revision.id=retained.revision_id
           WHERE retained.depth<2 AND revision.expected_previous_revision_id IS NOT NULL
         ), expected(revision_id,depth) AS (VALUES (?,0),(?,1),(?,2))
         SELECT COUNT(*) FROM retained
           JOIN expected USING (revision_id,depth)
           JOIN catalogue_exports AS export ON export.catalogue_revision_id=retained.revision_id
           WHERE export.verified=1 AND export.maintenance_state='available'
             AND EXISTS (SELECT 1 FROM catalogue_backup_attempts AS backup
               WHERE backup.catalogue_revision_id=retained.revision_id AND backup.state='verified'
                 AND backup.d1_bookmark IS NOT NULL AND backup.manifest_sha256 IS NOT NULL
             AND ${acceptedRevisionBackupSql("backup.catalogue_revision_id")}))
         AND EXISTS (SELECT 1 FROM catalogue_query_revisions
           WHERE catalogue_revision_id = ? AND state = 'archived')
     ) THEN 1 ELSE json_extract('invalid', '$') END`,
    )
    .bind(
      plan.expected_current_revision_id,
      plan.expected_migration_level,
      observedAt,
      ...gateBindings,
      plan.recovery_backup_attempt_id,
      plan.expected_current_revision_id,
      plan.recovery_bookmark,
      ...retainedRevisionIds,
      plan.smoke_targets.stale_revision_id,
    );
}
