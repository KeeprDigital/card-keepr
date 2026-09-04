import { type CatalogueStore, repositoryStatements } from "../shared";

export function guardNewCatalogueExportDeletionStatement(
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
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`WITH requested AS (
    SELECT ? AS id, ? AS plan_id, ? AS catalogue_revision_id,
      ? AS manifest_digest, ? AS expected_current_revision_id,
      ? AS object_set_digest, ? AS idempotency_key, ? AS request_json,
      ? AS requested_at
  ) SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM requested
  JOIN catalogue_export_deletion_plans AS plan
  JOIN catalogue_exports AS export
    ON export.catalogue_revision_id = plan.catalogue_revision_id
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  JOIN operation_state AS operation ON operation.singleton = 1
  WHERE plan.id = requested.plan_id
    AND plan.catalogue_revision_id = requested.catalogue_revision_id
    AND plan.manifest_digest = requested.manifest_digest
    AND plan.expected_current_revision_id = requested.expected_current_revision_id
    AND plan.object_set_digest = requested.object_set_digest
    AND plan.expires_at > requested.requested_at
    AND json_extract(requested.request_json, '$.plan_id') = plan.id
    AND json_extract(requested.request_json, '$.plan_digest') = plan.plan_digest
    AND json_extract(requested.request_json, '$.catalogue_revision_id') = plan.catalogue_revision_id
    AND json_extract(requested.request_json, '$.manifest_digest') = plan.manifest_digest
    AND json_extract(requested.request_json, '$.expected_current_revision_id') = plan.expected_current_revision_id
    AND json_extract(requested.request_json, '$.confirmation_revision_id') = plan.catalogue_revision_id
    AND json_extract(requested.request_json, '$.deletion_id') = requested.id
    AND json_extract(requested.request_json, '$.idempotency_key') = requested.idempotency_key
    AND export.maintenance_state = 'available'
    AND export.manifest_digest = plan.manifest_digest
    AND export.catalogue_revision_id <> catalogue.current_revision_id
    AND catalogue.current_revision_id = plan.expected_current_revision_id
    AND operation.active_ingestion_run_id IS NULL
    AND (
      operation.active_production_release_id IS NULL OR
      operation.active_production_release_expires_at <= requested.requested_at
    )
    AND operation.recovery_health = 'healthy'
) THEN 1
    ELSE json_extract('{}', 'catalogue_export_deletion_guard_failed') END`)
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
    );
}

export function guardRetryingCatalogueExportDeletionStatement(
  database: CatalogueStore,
  input: Readonly<{
    deletionId: string;
    idempotency_key: string;
    executionOwnerToken: string;
    executionLeaseExpiresAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalogue_export_deletions AS deletion
    WHERE deletion.id = ? AND deletion.state = 'failed'
      AND NOT COALESCE(? IS NOT NULL AND ? IS NOT NULL AND EXISTS (
        SELECT 1
        FROM catalogue_export_deletion_plans AS plan
        JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
        JOIN operation_state AS operation ON operation.singleton = 1
        JOIN catalogue_export_deletion_retries AS retry
          ON retry.deletion_id = deletion.id AND retry.idempotency_key = ?
        WHERE plan.id = deletion.plan_id
          AND plan.object_set_digest = deletion.object_set_digest
          AND catalogue.current_revision_id = deletion.expected_current_revision_id
          AND plan.catalogue_revision_id <> catalogue.current_revision_id
          AND operation.active_ingestion_run_id IS NULL
          AND retry.object_set_digest = deletion.object_set_digest
          AND retry.response_json IS NULL
          AND (operation.active_production_release_id IS NULL
            OR operation.active_production_release_expires_at <= retry.created_at)
          AND operation.recovery_health = 'healthy'
      ), 0)
  ) THEN 1 ELSE json_extract('{}', 'catalogue_export_deletion_transition_invalid') END`)
    .bind(input.deletionId, input.executionOwnerToken, input.executionLeaseExpiresAt, input.idempotency_key);
}

export function guardMarkingCatalogueExportDeletingStatement(
  database: CatalogueStore,
  input: Readonly<{ deletion_id: string; catalogue_revision_id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalogue_exports AS export
    WHERE export.catalogue_revision_id = ? AND export.maintenance_state = 'available'
      AND NOT COALESCE(export.deletion_operation_id IS NULL AND export.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM catalogue_export_deletions AS deletion
          WHERE deletion.id = ? AND deletion.catalogue_revision_id = export.catalogue_revision_id
            AND deletion.state = 'deleting'
        ), 0)
  ) THEN 1 ELSE json_extract('{}', 'catalogue_export_maintenance_transition_invalid') END`)
    .bind(input.catalogue_revision_id, input.deletion_id);
}

export function guardRecordingCatalogueExportDeletionResponseStatement(
  database: CatalogueStore,
  input: Readonly<{ deletionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalogue_export_deletions
    WHERE id = ? AND state = 'deleting' AND confirmation_response_json IS NULL
      AND (execution_owner_token IS NULL OR execution_lease_expires_at IS NULL)
  ) THEN 1 ELSE json_extract('{}', 'catalogue_export_deletion_transition_invalid') END`)
    .bind(input.deletionId);
}
