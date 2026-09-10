export function seedAcceptanceCheckpoint(db) {
  db.exec(`CREATE TABLE catalogue_revisions(id TEXT PRIMARY KEY, publication_operation_id TEXT, content_digest TEXT);
    CREATE TABLE catalogue_state(singleton INTEGER PRIMARY KEY,current_revision_id TEXT);
    INSERT INTO catalogue_state VALUES(1,'revision');
    CREATE TABLE game_candidates(id TEXT PRIMARY KEY, ingestion_run_id TEXT);
    CREATE TABLE game_publication_operations(id TEXT PRIMARY KEY,candidate_id TEXT,state TEXT,resulting_revision_id TEXT);
    CREATE TABLE catalogue_acceptance_head(singleton INTEGER PRIMARY KEY,publication_operation_id TEXT);
    CREATE TABLE catalogue_backup_attempts(idempotency_key TEXT PRIMARY KEY,request_json TEXT,owner_token TEXT,
      catalogue_revision_id TEXT,state TEXT,object_key TEXT,started_at TEXT,linked_attempt_id TEXT,
      publication_operation_id TEXT,publication_ingestion_run_id TEXT,d1_bookmark TEXT,manifest_sha256 TEXT,completed_at TEXT);
    INSERT INTO catalogue_revisions VALUES('revision','original','consumer-digest');
    INSERT INTO game_candidates VALUES('original-candidate','original-run'),('refresh-candidate','refresh-run');
    INSERT INTO game_publication_operations VALUES('original','original-candidate','published','revision'),
      ('refresh','refresh-candidate','published','revision');
    INSERT INTO catalogue_acceptance_head VALUES(1,'refresh');
    INSERT INTO catalogue_backup_attempts(idempotency_key,catalogue_revision_id,state,publication_operation_id,d1_bookmark,manifest_sha256)
      VALUES('old-verified','revision','verified','original','old-bookmark','old-manifest'),
      ('refresh-failed','revision','failed','refresh',NULL,NULL);`);
}
export function backupIdentity(db) {
  return db.prepare(`SELECT catalogue_revision_id,publication_operation_id,publication_ingestion_run_id,linked_attempt_id
    FROM catalogue_backup_attempts WHERE idempotency_key=?`);
}
export function markBackupVerified(db) {
  return db.prepare(`UPDATE catalogue_backup_attempts SET state='verified',d1_bookmark='fresh-bookmark',manifest_sha256='fresh-manifest'
    WHERE idempotency_key=?`);
}
export function removeAcceptanceHead(db) {
  return db.prepare("DELETE FROM catalogue_acceptance_head");
}
