import {
  guardNewCatalogueExportDeletionStatement,
  guardRetryingCatalogueExportDeletionStatement,
  guardMarkingCatalogueExportDeletingStatement,
  guardRecordingCatalogueExportDeletionResponseStatement,
} from "./export-deletion-guard-repository";
import { type CatalogueStore, repositoryStatements, atomicRepositoryStatement } from "../shared";
export type CatalogueExportRow = {
  catalogue_revision_id: string;
  manifest_key: string;
  manifest_digest: string;
  maintenance_state: "available" | "deleting" | "deleted";
};

export function catalogueExportStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT catalogue_revision_id, manifest_key, manifest_digest,
            maintenance_state
     FROM catalogue_exports WHERE catalogue_revision_id = ?`,
    )
    .bind(revisionId);
}

export type CatalogueExportDeletionPlanInput = {
  id: string;
  catalogue_revision_id: string;
  manifest_digest: string;
  expected_current_revision_id: string;
  object_keys_json: string;
  component_names_json: string;
  object_set_digest: string;
  dependencies_json: string;
  plan_digest: string;
  created_at: string;
  expires_at: string;
};

export function catalogueExportDeletionPlanInsertStatement(
  database: CatalogueStore,
  input: CatalogueExportDeletionPlanInput,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `INSERT INTO catalogue_export_deletion_plans (
       id, catalogue_revision_id, manifest_digest,
       expected_current_revision_id, object_keys_json, component_names_json,
       object_set_digest,
       dependencies_json, plan_digest, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.catalogue_revision_id,
      input.manifest_digest,
      input.expected_current_revision_id,
      input.object_keys_json,
      input.component_names_json,
      input.object_set_digest,
      input.dependencies_json,
      input.plan_digest,
      input.created_at,
      input.expires_at,
    );
}

export function catalogueExportDeletionPlanExistsStatement(
  database: CatalogueStore,
  input: Readonly<{ plan_id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT 1 AS present FROM catalogue_export_deletion_plans WHERE id = ?")
    .bind(input.plan_id);
}

export function catalogueExportDeletionByIdempotencyStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT * FROM catalogue_export_deletions WHERE idempotency_key = ?")
    .bind(input.idempotency_key);
}

export function catalogueExportManifestKeyStatement(
  database: CatalogueStore,
  input: Readonly<{ catalogueRevisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT manifest_key FROM catalogue_exports WHERE catalogue_revision_id = ?")
    .bind(input.catalogueRevisionId);
}

export function catalogueExportForDeletionStatement(
  database: CatalogueStore,
  input: Readonly<{ catalogue_revision_id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT catalogue_revision_id, manifest_key, manifest_digest, maintenance_state
     FROM catalogue_exports WHERE catalogue_revision_id = ?`)
    .bind(input.catalogue_revision_id);
}

export function catalogueExportDeletionExistsStatement(
  database: CatalogueStore,
  input: Readonly<{ deletion_id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT 1 AS present FROM catalogue_export_deletions WHERE id = ?")
    .bind(input.deletion_id);
}

export function insertCatalogueExportDeletionStatement(
  database: CatalogueStore,
  input: Readonly<{
    deletionId: string;
    planId: string;
    catalogueRevisionId: string;
    manifestDigest: string;
    expectedCurrentRevisionId: string;
    objectSetDigest: string;
    idempotencyKey: string;
    requestJson: string;
    observedAt: string;
    executionOwnerToken: string;
    executionLeaseExpiresAt: string;
  }>,
): D1PreparedStatement {
  const statement = repositoryStatements(database)
    .prepare(`INSERT INTO catalogue_export_deletions (
           id, plan_id, state, catalogue_revision_id, manifest_digest,
           expected_current_revision_id, object_set_digest, idempotency_key,
           request_json, requested_at, completed_at, failure_code,
           retry_owner_idempotency_key, execution_owner_token,
           execution_lease_expires_at, confirmation_response_json
         ) VALUES (?, ?, 'deleting', ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
           NULL, ?, ?, NULL)`)
    .bind(
      input.deletionId,
      input.planId,
      input.catalogueRevisionId,
      input.manifestDigest,
      input.expectedCurrentRevisionId,
      input.objectSetDigest,
      input.idempotencyKey,
      input.requestJson,
      input.observedAt,
      input.executionOwnerToken,
      input.executionLeaseExpiresAt,
    );
  return atomicRepositoryStatement(database, {
    statement,
    before: [guardNewCatalogueExportDeletionStatement(database, input)],
  });
}

export function markCatalogueExportDeletingStatement(
  database: CatalogueStore,
  input: Readonly<{ deletion_id: string; catalogue_revision_id: string }>,
): D1PreparedStatement {
  const statement = repositoryStatements(database)
    .prepare(`UPDATE catalogue_exports
         SET maintenance_state = 'deleting', deletion_operation_id = ?
         WHERE catalogue_revision_id = ? AND maintenance_state = 'available'`)
    .bind(input.deletion_id, input.catalogue_revision_id);
  return atomicRepositoryStatement(database, {
    statement,
    before: [guardMarkingCatalogueExportDeletingStatement(database, input)],
  });
}

export function catalogueExportDeletionConfirmationReplayStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      "SELECT request_json, confirmation_response_json FROM catalogue_export_deletions WHERE idempotency_key = ?",
    )
    .bind(input.idempotency_key);
}

export function catalogueExportDeletionByIdStatement(
  database: CatalogueStore,
  input: Readonly<{ deletionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT * FROM catalogue_export_deletions WHERE id = ?")
    .bind(input.deletionId);
}

export function catalogueExportDeletionRetryStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT deletion_id, object_set_digest, request_json, response_json
     FROM catalogue_export_deletion_retries WHERE idempotency_key = ?`)
    .bind(input.idempotency_key);
}

export function insertCatalogueExportDeletionRetryStatement(
  database: CatalogueStore,
  input: Readonly<{
    idempotency_key: string;
    deletionId: string;
    object_set_digest: string;
    requestJson: string;
    observedAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO catalogue_export_deletion_retries (
             idempotency_key, deletion_id, object_set_digest,
             request_json, response_json, created_at
           ) VALUES (?, ?, ?, ?, NULL, ?)`)
    .bind(input.idempotency_key, input.deletionId, input.object_set_digest, input.requestJson, input.observedAt);
}

export function claimCatalogueExportDeletionRetryStatement(
  database: CatalogueStore,
  input: Readonly<{
    idempotency_key: string;
    executionOwnerToken: string;
    executionLeaseExpiresAt: string;
    deletionId: string;
  }>,
): D1PreparedStatement {
  const statement = repositoryStatements(database)
    .prepare(`UPDATE catalogue_export_deletions
           SET state = 'deleting', failure_code = NULL,
               retry_owner_idempotency_key = ?, execution_owner_token = ?,
               execution_lease_expires_at = ?
           WHERE id = ? AND state = 'failed'`)
    .bind(input.idempotency_key, input.executionOwnerToken, input.executionLeaseExpiresAt, input.deletionId);
  return atomicRepositoryStatement(database, {
    statement,
    before: [guardRetryingCatalogueExportDeletionStatement(database, input)],
  });
}

export function guardCatalogueExportDeletionRetryStatement(
  database: CatalogueStore,
  input: Readonly<{
    deletionId: string;
    idempotency_key: string;
    executionOwnerToken: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
             SELECT 1 FROM catalogue_export_deletions
             WHERE id = ? AND state = 'deleting'
               AND retry_owner_idempotency_key = ?
               AND execution_owner_token = ?
           ) THEN 1 ELSE json_extract('invalid', '$') END`)
    .bind(input.deletionId, input.idempotency_key, input.executionOwnerToken);
}

export function catalogueExportDeletionRetryReplayStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT request_json, response_json
         FROM catalogue_export_deletion_retries WHERE idempotency_key = ?`)
    .bind(input.idempotency_key);
}

export function persistCatalogueExportDeletionRetryResponseStatement(
  database: CatalogueStore,
  input: Readonly<{ responseJson: string; idempotencyKey: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_export_deletion_retries SET response_json = ?
     WHERE idempotency_key = ? AND response_json IS NULL`)
    .bind(input.responseJson, input.idempotencyKey);
}

export function completeCatalogueExportDeletionStatement(
  database: CatalogueStore,
  input: Readonly<{
    observedAt: string;
    responseJson: string;
    deletionId: string;
    retryIdempotencyKey: string | null;
    executionOwnerToken: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_export_deletions
         SET state = 'deleted', completed_at = ?, failure_code = NULL,
             confirmation_response_json = COALESCE(confirmation_response_json, ?)
         WHERE id = ? AND state = 'deleting'
           AND retry_owner_idempotency_key IS ?
           AND execution_owner_token = ?`)
    .bind(input.observedAt, input.responseJson, input.deletionId, input.retryIdempotencyKey, input.executionOwnerToken);
}

export function markCatalogueExportDeletedStatement(
  database: CatalogueStore,
  input: Readonly<{ observedAt: string; catalogue_revision_id: string; deletionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_exports
         SET maintenance_state = 'deleted', deleted_at = ?
         WHERE catalogue_revision_id = ? AND maintenance_state = 'deleting'
           AND deletion_operation_id = ?`)
    .bind(input.observedAt, input.catalogue_revision_id, input.deletionId);
}

export function insertCatalogueExportDeletionTombstoneStatement(
  database: CatalogueStore,
  input: Readonly<{
    catalogue_revision_id: string;
    deletionId: string;
    manifest_digest: string;
    object_set_digest: string;
    observedAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO catalogue_export_deletion_tombstones (
           catalogue_revision_id, deletion_id, manifest_digest,
           object_set_digest, deleted_at
         ) VALUES (?, ?, ?, ?, ?)`)
    .bind(
      input.catalogue_revision_id,
      input.deletionId,
      input.manifest_digest,
      input.object_set_digest,
      input.observedAt,
    );
}

export function failCatalogueExportDeletionStatement(
  database: CatalogueStore,
  input: Readonly<{
    responseJson: string;
    deletionId: string;
    retryIdempotencyKey: string | null;
    executionOwnerToken: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_export_deletions
         SET state = 'failed', failure_code = 'deleted_object_set_mismatch',
             confirmation_response_json = COALESCE(confirmation_response_json, ?)
         WHERE id = ? AND state = 'deleting'
           AND retry_owner_idempotency_key IS ?
           AND execution_owner_token = ?`)
    .bind(input.responseJson, input.deletionId, input.retryIdempotencyKey, input.executionOwnerToken);
}

export function claimCatalogueExportDeletionLeaseStatement(
  database: CatalogueStore,
  input: Readonly<{
    executionOwnerToken: string;
    executionLeaseExpiresAt: string;
    deletionId: string;
    retryIdempotencyKey: string | null;
    observedAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_export_deletions
         SET execution_owner_token = ?, execution_lease_expires_at = ?
         WHERE id = ? AND state = 'deleting'
           AND retry_owner_idempotency_key IS ?
           AND (execution_owner_token IS NULL
             OR execution_lease_expires_at <= ?)`)
    .bind(
      input.executionOwnerToken,
      input.executionLeaseExpiresAt,
      input.deletionId,
      input.retryIdempotencyKey,
      input.observedAt,
    );
}

export function renewCatalogueExportDeletionLeaseStatement(
  database: CatalogueStore,
  input: Readonly<{
    renewedLeaseExpiresAt: string;
    deletionId: string;
    retryIdempotencyKey: string | null;
    executionOwnerToken: string;
    observedAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_export_deletions
         SET execution_lease_expires_at = ?
         WHERE id = ? AND state = 'deleting'
           AND retry_owner_idempotency_key IS ?
           AND execution_owner_token = ?
           AND execution_lease_expires_at > ?`)
    .bind(
      input.renewedLeaseExpiresAt,
      input.deletionId,
      input.retryIdempotencyKey,
      input.executionOwnerToken,
      input.observedAt,
    );
}

export function guardRenewedCatalogueExportDeletionLeaseStatement(
  database: CatalogueStore,
  input: Readonly<{
    deletionId: string;
    retryIdempotencyKey: string | null;
    executionOwnerToken: string;
    renewedLeaseExpiresAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
           SELECT 1 FROM catalogue_export_deletions
           WHERE id = ? AND state = 'deleting'
             AND retry_owner_idempotency_key IS ?
             AND execution_owner_token = ?
             AND execution_lease_expires_at = ?
         ) THEN 1 ELSE json_extract('invalid', '$') END`)
    .bind(input.deletionId, input.retryIdempotencyKey, input.executionOwnerToken, input.renewedLeaseExpiresAt);
}

export function persistCatalogueExportDeletionAcceptedResponseStatement(
  database: CatalogueStore,
  input: Readonly<{ acceptedResponseJson: string; deletionId: string }>,
): D1PreparedStatement {
  const statement = repositoryStatements(database)
    .prepare(`UPDATE catalogue_export_deletions
       SET confirmation_response_json = ?
       WHERE id = ? AND state = 'deleting'
         AND confirmation_response_json IS NULL`)
    .bind(input.acceptedResponseJson, input.deletionId);
  return atomicRepositoryStatement(database, {
    statement,
    before: [guardRecordingCatalogueExportDeletionResponseStatement(database, input)],
  });
}

export function persistCatalogueExportDeletionRetryAcceptedResponseStatement(
  database: CatalogueStore,
  input: Readonly<{ acceptedResponseJson: string; retryIdempotencyKey: string; deletionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_export_deletion_retries SET response_json = ?
       WHERE idempotency_key = ? AND deletion_id = ?
         AND response_json IS NULL`)
    .bind(input.acceptedResponseJson, input.retryIdempotencyKey, input.deletionId);
}

export function catalogueExportDeletionConfirmationResponseStatement(
  database: CatalogueStore,
  input: Readonly<{ deletionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT confirmation_response_json FROM catalogue_export_deletions WHERE id = ?")
    .bind(input.deletionId);
}

export function catalogueExportDeletionRetryResponseStatement(
  database: CatalogueStore,
  input: Readonly<{ retryIdempotencyKey: string; deletionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      "SELECT response_json FROM catalogue_export_deletion_retries WHERE idempotency_key = ? AND deletion_id = ?",
    )
    .bind(input.retryIdempotencyKey, input.deletionId);
}

export function catalogueExportMaintenanceStateStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(
    database,
  ).prepare(`SELECT catalogue.current_revision_id, operation.active_ingestion_run_id,
            operation.active_production_release_id,
            operation.active_production_release_expires_at,
            operation.recovery_health
     FROM catalogue_state AS catalogue
     JOIN operation_state AS operation ON operation.singleton = catalogue.singleton
     WHERE catalogue.singleton = 1`);
}

export function catalogueExportCurrentRevisionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1");
}

export function catalogueExportDeletionPlanStatement(
  database: CatalogueStore,
  input: Readonly<{ planId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT * FROM catalogue_export_deletion_plans WHERE id = ?")
    .bind(input.planId);
}

export function guardCatalogueExportDeletionExecutionStatement(
  database: CatalogueStore,
  deletionId: string,
  retryIdempotencyKey: string | null,
  executionOwnerToken: string,
  leaseObservedAt?: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM catalogue_export_deletions
       WHERE id = ? AND state = 'deleting'
         AND retry_owner_idempotency_key IS ?
         AND execution_owner_token = ?
         ${leaseObservedAt === undefined ? "" : "AND execution_lease_expires_at > ?"}
     ) THEN 1 ELSE json_extract('invalid', '$') END`,
    )
    .bind(
      deletionId,
      retryIdempotencyKey,
      executionOwnerToken,
      ...(leaseObservedAt === undefined ? [] : [leaseObservedAt]),
    );
}
