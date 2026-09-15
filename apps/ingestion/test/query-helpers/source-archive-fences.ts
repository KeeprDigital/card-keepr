import { repositoryStatements, type CatalogueStore } from "../../../../src/catalogue/shared";

// Prepared before the fence: identical retries remain legal while authority is clear.
export function archiveFenceProbes(db: CatalogueStore) {
  const statements = repositoryStatements(db);
  return [
    {
      table: "decodes",
      insert: statements.prepare("INSERT OR IGNORE INTO source_archive_decodes SELECT * FROM source_archive_decodes"),
      update: statements.prepare("UPDATE source_archive_decodes SET next_record=next_record"),
      remove: statements.prepare("DELETE FROM source_archive_decodes"),
    },
    {
      table: "blocks",
      insert: statements.prepare("INSERT OR IGNORE INTO source_archive_blocks SELECT * FROM source_archive_blocks"),
      update: statements.prepare("UPDATE source_archive_blocks SET state=state"),
      remove: statements.prepare("DELETE FROM source_archive_blocks"),
    },
    {
      table: "parse_progress",
      insert: statements.prepare(
        "INSERT OR IGNORE INTO source_archive_parse_progress SELECT * FROM source_archive_parse_progress",
      ),
      update: statements.prepare("UPDATE source_archive_parse_progress SET next_record=next_record"),
      remove: statements.prepare("DELETE FROM source_archive_parse_progress"),
    },
    {
      table: "record_receipts",
      insert: statements.prepare(
        "INSERT OR IGNORE INTO source_archive_record_receipts SELECT * FROM source_archive_record_receipts",
      ),
      update: statements.prepare("UPDATE source_archive_record_receipts SET sha256=sha256"),
      remove: statements.prepare("DELETE FROM source_archive_record_receipts"),
    },
  ];
}

export function archiveFenceRows(db: CatalogueStore) {
  const statements = repositoryStatements(db);
  return [
    statements.prepare("SELECT * FROM source_archive_decodes ORDER BY source_snapshot_id"),
    statements.prepare("SELECT * FROM source_archive_blocks ORDER BY source_snapshot_id,ordinal"),
    statements.prepare("SELECT * FROM source_archive_parse_progress ORDER BY observation_set_id"),
    statements.prepare("SELECT * FROM source_archive_record_receipts ORDER BY observation_set_id,ordinal"),
  ];
}

export function archiveRecoveryFence(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "UPDATE operation_state SET recovery_restore_guard='blocked' WHERE singleton=1",
  );
}

// Install retained handoff authority as an imported row. Only the handoff claim
// precondition is bypassed; restore its exact definition before any writer probe.
// This tests archive enforcement, not the separately covered handoff owner flow.
export function archiveHandoffClaimTrigger(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='fresh_baseline_claim_guard'",
  );
}
export function removeArchiveHandoffClaimTrigger(db: CatalogueStore) {
  return repositoryStatements(db).prepare("DROP TRIGGER fresh_baseline_claim_guard");
}
export function archiveHandoffFence(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO fresh_baseline_handoffs
    (release_id,role,dispatch_digest,execution_id,request_json,preparation_json,phase,evidence_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
}
export function archiveRestoredBackup(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO catalogue_backup_attempts
    (idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,started_at)
    VALUES (?,?,?,?,?,?,?)`);
}
export function archiveRestoredRecovery(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO catalogue_recovery_operations
    (id,state,method,request_json,idempotency_key,target_revision_id,target_bookmark,target_digest,
     source_backup_attempt_id,expected_current_revision_id,original_database_id,expected_schema_migration_level,
     expected_verification_json,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
}
export function archiveRestoredClassification(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO catalogue_recovery_collection_classifications
    (recovery_id,ingestion_run_id,prior_state,classification)
    VALUES (?,?,?,?)`);
}
