// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function insertCatalogueExports(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_exports (
        catalogue_revision_id, manifest_key, manifest_digest, verified
      ) VALUES (?, ?, ?, 1)`);
}

export function deleteCatalogueExports(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM catalogue_exports WHERE catalogue_revision_id = ?`);
}

export function readCatalogueExportsManifestKeyManifestDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT manifest_key, manifest_digest FROM catalogue_exports
     WHERE catalogue_revision_id = 'catrev_export_deleted_old'`);
}

export function insertCatalogueExportDeletionPlans(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_export_deletion_plans (
       id, catalogue_revision_id, manifest_digest,
       expected_current_revision_id, object_keys_json, component_names_json,
       object_set_digest,
       dependencies_json, plan_digest, created_at, expires_at
     ) VALUES (?, 'catrev_export_deleted_old', ?,
       'catrev_export_deleted_current', ?, '["cards"]', ?, '[]', ?,
       '2026-07-20T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`);
}

export function insertCatalogueExportDeletions(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_export_deletions (
         id, plan_id, state, catalogue_revision_id, manifest_digest,
         expected_current_revision_id, object_set_digest, idempotency_key,
         request_json, requested_at, completed_at, failure_code
       ) VALUES (?, ?, 'deleting', 'catrev_export_deleted_old', ?,
         'catrev_export_deleted_current', ?, ?, ?,
         '2026-07-20T00:01:00.000Z', NULL, NULL)`);
}

export function setCatalogueExportsMaintenanceStateDeletionOperationId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_exports
       SET maintenance_state = 'deleting', deletion_operation_id = ?
       WHERE catalogue_revision_id = 'catrev_export_deleted_old'`);
}

export function insertCatalogueExportsForCardCursorsContinueOnAvailablePinnedRevisionConflictOnly(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_exports (
       catalogue_revision_id, manifest_key, manifest_digest, verified
     ) VALUES (
       'catrev_cursor_old',
       'catalogue/catrev_cursor_old/manifest.json',
       ?, 1
     )`);
}

export function readCatalogueRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT
         EXISTS(
           SELECT 1 FROM catalogue_revisions
           WHERE id = 'catrev_cursor_old'
         ) AS revision_retained,
         EXISTS(
           SELECT 1 FROM catalogue_exports
           WHERE catalogue_revision_id = 'catrev_cursor_old'
         ) AS export_retained`);
}

export function readCatalogueExportsCatalogueRevisionIdManifestKey(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT catalogue_revision_id, manifest_key, manifest_digest, verified
     FROM catalogue_exports WHERE catalogue_revision_id = ?`);
}

export function insertCatalogueExportDeletionsForExactConfirmationReplayResumesInterruptedDeletingOperation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_export_deletions (
         id, plan_id, state, catalogue_revision_id, manifest_digest,
         expected_current_revision_id, object_set_digest, idempotency_key,
         request_json, requested_at, completed_at, failure_code
       ) VALUES (?, ?, 'deleting', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`);
}

export function setCatalogueExportsMaintenanceStateDeletionOperationIdForExactConfirmationReplayResumesInterruptedDeletingOperation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_exports
       SET maintenance_state = 'deleting', deletion_operation_id = ?
       WHERE catalogue_revision_id = ?`);
}

export function setCatalogueExportDeletionsExecutionLeaseExpiresAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_export_deletions
     SET execution_lease_expires_at = ? WHERE id = ?`);
}

export function readCatalogueExportsManifestKey(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ?`);
}

export function readCatalogueExportsManifestKeyForExportComponentRecords(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ? AND verified = 1`);
}

export function readCatalogueExports(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT * FROM catalogue_exports WHERE catalogue_revision_id = ?`);
}

export function readCatalogueExportsManifestKeyManifestDigestForLocatorSourceBucketEvidenceRefreshWithoutMintingCatalogueRevisionsOr(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT manifest_key, manifest_digest
     FROM catalogue_exports
     WHERE catalogue_revision_id = ?`);
}
