import { type CatalogueStore, repositoryStatements } from "../shared";

export function guardCompletingBackupEvidenceStatement(
  database: CatalogueStore,
  input: Readonly<{
    idempotencyKey: string;
    ownerToken: string;
    manifestKey: string;
    manifestSha256: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM catalogue_backup_attempts
      WHERE idempotency_key = ? AND owner_token = ? AND state = 'verifying'
        AND NOT COALESCE(
          ? IS NOT NULL
          AND content_sha256 NOT GLOB '*[^0-9a-f]*' AND length(content_sha256) = 64
          AND ? NOT GLOB '*[^0-9a-f]*' AND length(?) = 64
          AND export_bytes >= 0 AND schema_migration_level > 0
          AND length(disposable_database_id) > 0 AND restore_generation > 0,
          0)
    ) THEN 1 ELSE json_extract('{}', 'verified_backup_evidence_incomplete') END`)
    .bind(input.idempotencyKey, input.ownerToken, input.manifestKey, input.manifestSha256, input.manifestSha256);
}

export function guardRehydratedBackupEvidenceStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM catalogue_backup_attempts
      WHERE idempotency_key = ? AND state = 'verifying'
        AND NOT COALESCE(
          manifest_key IS NOT NULL
          AND content_sha256 NOT GLOB '*[^0-9a-f]*' AND length(content_sha256) = 64
          AND manifest_sha256 NOT GLOB '*[^0-9a-f]*' AND length(manifest_sha256) = 64
          AND export_bytes >= 0 AND schema_migration_level > 0
          AND length(disposable_database_id) > 0 AND restore_generation > 0,
          0)
    ) THEN 1 ELSE json_extract('{}', 'verified_backup_evidence_incomplete') END`)
    .bind(input.idempotency_key);
}
