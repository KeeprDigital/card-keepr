// Named SQLite statements; tests retain bindings, execution, and assertions.

export function foreignKeyViolations(database) {
  return database.prepare("PRAGMA foreign_key_check");
}

export function integrityCheck(database) {
  return database.prepare("PRAGMA integrity_check");
}

export function schemaDefinitionRows(database) {
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name");
}

export function seedTableNames(database) {
  return database.prepare(`SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name NOT IN ('catalogue_schema_state')
     ORDER BY name`);
}

export function schemaMigrationLevel(database) {
  return database.prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1");
}

export function sourceRequestTableExists(database) {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'source_requests'");
}

export function setUnexpectedSchemaLevel(database) {
  return database.prepare("UPDATE catalogue_schema_state SET migration_level = 99 WHERE singleton = 1");
}

export function ownerRunState(database) {
  return database.prepare("SELECT state FROM ingestion_runs WHERE id = 'run_owner'");
}

export function projectedPrintingImageFacts(database) {
  return database.prepare(`SELECT media_type, content_sha256, content_byte_length, object_key
         FROM revision_printing_images WHERE image_id = 'image_0004'`);
}

export function projectedLegalitySourceTime(database) {
  return database.prepare(
    "SELECT source_retrieved_at FROM revision_legality_rules WHERE legality_rule_id = 'legality_0004'",
  );
}

export function schemaIndexNames(database) {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name");
}

export function schemaObjectRows(database) {
  return database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name");
}

// Every row of every table except the schema level itself.
export function seedRows(database) {
  const tables = seedTableNames(database)
    .all()
    .map((row) => row.name);
  const seeds = {};
  for (const table of tables) {
    const rows = database
      .prepare(`SELECT * FROM "${table}"`)
      .all()
      .map((row) => JSON.stringify(row, blobsAsHex))
      .sort();
    if (rows.length > 0) seeds[table] = rows;
  }
  return seeds;
}

function blobsAsHex(_key, value) {
  return value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value;
}

export function explainCardPrintings(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT document_json FROM revision_printings\n       WHERE catalogue_revision_id = ? AND card_id = ?\n       ORDER BY printing_id",
  );
}

export function explainRecentSnapshots(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM source_snapshots WHERE ingestion_run_id = ?\n       ORDER BY retrieved_at DESC, id DESC LIMIT ?",
  );
}

export function explainSnapshotCount(database) {
  return database.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM source_snapshots WHERE ingestion_run_id = ?");
}

export function explainRecentFetchAttempts(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM source_fetch_attempts WHERE ingestion_run_id = ?\n       ORDER BY completed_at DESC, request_id DESC, attempt_number DESC LIMIT ?",
  );
}

export function explainPrintingLocators(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT printing_id, source_lineage, locator FROM reconciled_printing_locators\n       WHERE printing_id = ? ORDER BY locator",
  );
}

export function explainPrintingLocatorSets(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT printing_id, source_lineage, locator, variant_key\n       FROM reconciled_printing_locators\n       WHERE printing_id IN (SELECT value FROM json_each(?))\n       ORDER BY printing_id, source_lineage, locator, COALESCE(variant_key, '')",
  );
}

export function explainRevisionBackups(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT idempotency_key FROM catalogue_backup_attempts\n       WHERE catalogue_revision_id = ?\n       ORDER BY started_at DESC, idempotency_key DESC",
  );
}

export function explainVerifiedRevisionBackup(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT idempotency_key FROM catalogue_backup_attempts\n       WHERE state = 'verified' AND catalogue_revision_id = ?\n         AND d1_bookmark IS NOT NULL AND manifest_sha256 IS NOT NULL\n       ORDER BY completed_at DESC LIMIT 1",
  );
}

export function explainBackupRetryChild(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT idempotency_key FROM catalogue_backup_attempts WHERE linked_attempt_id = ? LIMIT 1",
  );
}

export function explainRecentIngestionRuns(database) {
  return database.prepare("EXPLAIN QUERY PLAN SELECT * FROM ingestion_runs ORDER BY started_at DESC, id DESC LIMIT 20");
}

export function explainRecoverablePublications(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM ingestion_run_current\n       WHERE state = 'publishing'\n         AND publication_reconcile_after IS NOT NULL\n         AND publication_reconcile_after <= ?\n       ORDER BY publication_reconcile_after, ingestion_run_id LIMIT 1",
  );
}

export function explainExpiredRuns(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT ingestion_run_id AS id FROM ingestion_run_current WHERE state = 'expired'",
  );
}

export function explainRevisionProducts(database) {
  return database.prepare(
    "EXPLAIN QUERY PLAN SELECT product_id FROM revision_products WHERE catalogue_revision_id = ? ORDER BY product_id",
  );
}

export function explainRevisionErrata(database) {
  return database.prepare("EXPLAIN QUERY PLAN SELECT erratum_id FROM revision_errata WHERE catalogue_revision_id = ?");
}

export function retainedWorkflowPauses(database) {
  return database.prepare("SELECT * FROM ingestion_run_workflow_pauses ORDER BY ingestion_run_id");
}

export function retainedTerminations(database) {
  return database.prepare("SELECT * FROM ingestion_run_terminations ORDER BY ingestion_run_id");
}

export function reconciliationContextColumns(database) {
  return database.prepare("PRAGMA table_info(reconciliation_contexts)");
}
export function reconciliationContextCount(database) {
  return database.prepare("SELECT count(*) AS count FROM reconciliation_contexts");
}

export function operationStateColumns(database) {
  return database.prepare("PRAGMA table_info(operation_state)");
}
export function queryRevisionColumns(database) {
  return database.prepare("PRAGMA table_info(catalogue_query_revisions)");
}
export function canonicalReleaseLease(database) {
  return database.prepare(
    "SELECT active_production_release_id, active_production_release_expires_at FROM operation_state WHERE singleton = 1",
  );
}
export function seedPreGuardMigrationLease(database) {
  return database.prepare(
    "UPDATE operation_state SET active_production_release_id = 'release_migration', active_production_release_expires_at = '2099-01-01T00:00:00.000Z' WHERE singleton = 1",
  );
}
