import {
  type CatalogueStore,
  repositoryStatements,
  atomicRepositoryStatement,
  verifiedRunCurrentSql,
  runCurrentIntegrityGuardStatement,
} from "../shared";

export function cleanupById(db: CatalogueStore, id: string) {
  return repositoryStatements(db).prepare(`SELECT * FROM evidence_cleanup_operations WHERE id=?`).bind(id);
}
export function cleanupByKey(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare(`SELECT * FROM evidence_cleanup_operations WHERE idempotency_key=?`)
    .bind(key);
}
export function cleanupRun(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT current.state, current.terminal_at FROM ingestion_runs run LEFT JOIN ingestion_run_current current ON current.ingestion_run_id=run.id WHERE run.id=? AND CASE WHEN ${verifiedRunCurrentSql} THEN 1 ELSE json_extract('{}','ingestion_run_projection_mismatch') END`,
    )
    .bind(id);
}
export function insertCleanup(
  db: CatalogueStore,
  id: string,
  run: string,
  key: string,
  days: number,
  terminal: string,
  eligible: string,
  at: string,
) {
  const statement = repositoryStatements(db)
    .prepare(`INSERT INTO evidence_cleanup_operations
    (id, ingestion_run_id, idempotency_key, retention_days, terminal_at, eligible_at, created_at)
    SELECT ?,id,?,?,?,?,? FROM ingestion_run_read WHERE id=? AND terminal_at=?
    AND state IN ('failed','rejected','expired') ON CONFLICT DO NOTHING`)
    .bind(id, key, days, terminal, eligible, at, run, terminal);
  return atomicRepositoryStatement(db, { statement, before: [runCurrentIntegrityGuardStatement(db, run)] });
}
export function nextCleanupObject(db: CatalogueStore, run: string, cursor: string) {
  return repositoryStatements(db)
    .prepare(`SELECT object_key FROM evidence_cleanup_inventory
    WHERE ingestion_run_id=? AND object_key>? ORDER BY object_key LIMIT 1`)
    .bind(run, cursor);
}
export function finishCleanup(db: CatalogueStore, id: string, at: string) {
  return repositoryStatements(db)
    .prepare(`UPDATE evidence_cleanup_operations SET state='completed', completed_at=?, failure_code=NULL WHERE id=?`)
    .bind(at, id);
}

export function cleanupObject(db: CatalogueStore, key: string) {
  return repositoryStatements(db).prepare(`SELECT * FROM evidence_cleanup_objects WHERE object_key=?`).bind(key);
}
export function claimCleanupObject(db: CatalogueStore, id: string, key: string, at: string) {
  const statement = repositoryStatements(db)
    .prepare(`INSERT INTO evidence_cleanup_objects(object_key,cleanup_id,state,claimed_at)
    VALUES (?,?,'reserved',?) ON CONFLICT(object_key) DO NOTHING`)
    .bind(key, id, at);
  return atomicRepositoryStatement(db, { statement, before: [cleanupOwnerIntegrity(db, key)] });
}
export function deletedCleanupObject(db: CatalogueStore, key: string, at: string) {
  return repositoryStatements(db)
    .prepare(`UPDATE evidence_cleanup_objects SET state='deleted',deleted_at=? WHERE object_key=? AND state='deleting'`)
    .bind(at, key);
}
export function cleanupResultStatements(
  db: CatalogueStore,
  id: string,
  key: string,
  state: "waiting" | "protected" | "deleted",
  reason: string | null,
  retry: boolean,
) {
  const sql = repositoryStatements(db);
  return [
    sql
      .prepare(`UPDATE evidence_cleanup_operations SET
    deleted_objects=deleted_objects+CASE WHEN ?='deleted' AND NOT EXISTS(SELECT 1 FROM evidence_cleanup_results WHERE cleanup_id=? AND object_key=? AND state='deleted') THEN 1 ELSE 0 END,
    protected_objects=protected_objects+CASE WHEN ?='protected' AND NOT EXISTS(SELECT 1 FROM evidence_cleanup_results WHERE cleanup_id=? AND object_key=? AND state='protected') THEN 1 ELSE 0 END,
    cursor=CASE WHEN ?=0 AND cursor<? THEN ? ELSE cursor END,
    retry_cursor=CASE WHEN ?=1 AND retry_cursor<? THEN ? ELSE retry_cursor END,
    state='running',failure_code=NULL WHERE id=? AND state<>'completed'`)
      .bind(state, id, key, state, id, key, retry ? 1 : 0, key, key, retry ? 1 : 0, key, key, id),
    sql
      .prepare(`INSERT INTO evidence_cleanup_results VALUES (?,?,?,?)
    ON CONFLICT(cleanup_id,object_key) DO UPDATE SET state=excluded.state,reason=excluded.reason
    WHERE evidence_cleanup_results.state='waiting'`)
      .bind(id, key, state, reason),
  ];
}
export function nextWaitingCleanupObject(db: CatalogueStore, id: string, after: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT object_key FROM evidence_cleanup_results WHERE cleanup_id=? AND state='waiting' AND object_key>? ORDER BY object_key LIMIT 1`,
    )
    .bind(id, after);
}
export function waitingCleanupReason(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT reason FROM evidence_cleanup_results WHERE cleanup_id=? AND state='waiting' ORDER BY object_key LIMIT 1`,
    )
    .bind(id);
}
export function cleanupResults(db: CatalogueStore, id: string, after: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT object_key,state,reason FROM evidence_cleanup_results WHERE cleanup_id=? AND object_key>? ORDER BY object_key LIMIT 50`,
    )
    .bind(id, after);
}
export function pauseCleanup(db: CatalogueStore, id: string, code: string, generation?: number) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE evidence_cleanup_operations SET state='paused',retry_cursor='',failure_code=? WHERE id=? AND state<>'completed' AND (? IS NULL OR generation=?)`,
    )
    .bind(code, id, generation ?? null, generation ?? null);
}
export function cleanupDeleteGuard(db: CatalogueStore, key: string) {
  const statement = repositoryStatements(db)
    .prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=?)
    AND NOT EXISTS(SELECT 1 FROM evidence_cleanup_retained_keys WHERE object_key=?)
    AND NOT EXISTS(SELECT 1 FROM evidence_object_writers WHERE object_key=? AND completed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
    THEN 1 ELSE json_extract('{}','evidence_cleanup_reference_protected') END`)
    .bind(key, key, key);
  return atomicRepositoryStatement(db, { statement, before: [cleanupOwnerIntegrity(db, key)] });
}
export function beginEvidenceObjectWrite(db: CatalogueStore, token: string, run: string, key: string, at: string) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO evidence_object_writers(token,ingestion_run_id,object_key,started_at) VALUES (?,?,?,?)`)
    .bind(token, run, key, at);
}
export function completeEvidenceObjectWrite(db: CatalogueStore, token: string, at: string) {
  return repositoryStatements(db)
    .prepare(`UPDATE evidence_object_writers SET completed_at=? WHERE token=? AND completed_at IS NULL`)
    .bind(at, token);
}
export function retainEvidenceMultipart(db: CatalogueStore, token: string, upload: string) {
  return repositoryStatements(db)
    .prepare(`UPDATE evidence_object_writers SET multipart_upload_id=? WHERE token=? AND completed_at IS NULL`)
    .bind(upload, token);
}
export function openEvidenceWriter(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT token,multipart_upload_id FROM evidence_object_writers WHERE object_key=? AND completed_at IS NULL LIMIT 1`,
    )
    .bind(key);
}

export function attemptCleanup(db: CatalogueStore, id: string, at: string) {
  return repositoryStatements(db)
    .prepare(`UPDATE evidence_cleanup_operations SET last_attempt_at=? WHERE id=?`)
    .bind(at, id);
}
export function authorizeCleanupDelete(db: CatalogueStore, key: string) {
  const statement = repositoryStatements(db)
    .prepare(`UPDATE evidence_cleanup_objects SET state='deleting' WHERE object_key=? AND state='reserved'`)
    .bind(key);
  return atomicRepositoryStatement(db, { statement, before: [cleanupOwnerIntegrity(db, key)] });
}
export function resumeCleanup(db: CatalogueStore, id: string, generation: number) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE evidence_cleanup_operations SET generation=generation+1,state='pending',retry_cursor='',failure_code=NULL WHERE id=? AND generation=? AND state<>'completed'`,
    )
    .bind(id, generation);
}
/** Permanent decision/recovery pin, composed atomically with its owning record. */
export function retainEvidenceObjectReferenceStatement(
  db: CatalogueStore,
  input: { objectKey: string; ownerKind: string; ownerId: string; createdAt: string },
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO evidence_object_references VALUES (?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(input.objectKey, input.ownerKind, input.ownerId, input.createdAt);
}

function cleanupOwnerIntegrity(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare(`SELECT CASE WHEN EXISTS(
 SELECT 1 FROM (
 SELECT ingestion_run_id FROM evidence_cleanup_inventory WHERE object_key=?1
 UNION SELECT ref.ingestion_run_id FROM source_capture_operations ref JOIN evidence_cleanup_snapshot_keys keys ON keys.snapshot_id=ref.reused_source_snapshot_id WHERE keys.object_key=?1
 ) owners LEFT JOIN ingestion_run_current current ON current.ingestion_run_id=owners.ingestion_run_id
 WHERE (${verifiedRunCurrentSql}) IS NOT 1
 ) THEN json_extract('{}','ingestion_run_projection_mismatch') ELSE 1 END`)
    .bind(key);
}
