import { type CatalogueStore, repositoryStatements } from "../shared";
export type StagingObject = {
  binding: "PRINTING_IMAGES" | "CATALOGUE_EXPORTS";
  object_key: string;
  incarnation: number;
  state: string;
  cleanup_id: string | null;
};
export function stagingPreparation(db: CatalogueStore, id: string) {
  return repositoryStatements(db)
    .prepare(`SELECT id,ingestion_run_id,state,terminal_at FROM reconciliation_operations WHERE id=?`)
    .bind(id);
}
export function insertStagingCleanup(
  db: CatalogueStore,
  id: string,
  preparation: string,
  key: string,
  days: number,
  at: string,
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO evidence_cleanup_operations
 (id,ingestion_run_id,idempotency_key,retention_days,terminal_at,eligible_at,created_at,preparation_id,scope)
 SELECT ?,ingestion_run_id,?,?,terminal_at,strftime('%Y-%m-%dT%H:%M:%fZ',terminal_at,'+'||?||' days'),?,id,'staging'
 FROM reconciliation_operations WHERE id=? AND state IN ('failed','abandoned') AND terminal_at IS NOT NULL
 AND julianday(terminal_at)+?<=julianday(?) ON CONFLICT DO NOTHING`)
    .bind(id, key, days, days, at, preparation, days, at);
}
export function nextStagingInventory(db: CatalogueStore, preparation: string, after: string) {
  return repositoryStatements(db)
    .prepare(`SELECT DISTINCT binding||':'||object_key AS object_key FROM staging_object_writes
 WHERE preparation_id=? AND binding||':'||object_key>? ORDER BY object_key LIMIT 1`)
    .bind(preparation, after);
}
export function stagingObject(db: CatalogueStore, key: string) {
  return repositoryStatements(db).prepare(`SELECT * FROM staging_objects WHERE binding||':'||object_key=?`).bind(key);
}
export function reserveStagingObject(db: CatalogueStore, id: string, key: string, incarnation: number, at: string) {
  return repositoryStatements(db)
    .prepare(`UPDATE staging_objects SET state='reserved',cleanup_id=?,reserved_at=?
 WHERE binding||':'||object_key=? AND incarnation=? AND state='available'`)
    .bind(id, at, key, incarnation);
}
export function promoteStagingDelete(db: CatalogueStore, id: string, key: string, incarnation: number) {
  return repositoryStatements(db)
    .prepare(
      `UPDATE staging_objects SET state='deleting' WHERE binding||':'||object_key=? AND incarnation=? AND cleanup_id=? AND state='reserved'`,
    )
    .bind(key, incarnation, id);
}
export function openStagingTickets(db: CatalogueStore, key: string, incarnation: number) {
  return repositoryStatements(db)
    .prepare(`SELECT 'writer' AS kind FROM staging_object_writes WHERE binding||':'||object_key=? AND incarnation=? AND completed_at IS NULL
 UNION ALL SELECT 'deleter' AS kind FROM staging_object_deletes WHERE binding||':'||object_key=? AND incarnation=? AND completed_at IS NULL LIMIT 1`)
    .bind(key, incarnation, key, incarnation);
}
export function beginStagingDelete(
  db: CatalogueStore,
  id: string,
  key: string,
  incarnation: number,
  token: string,
  at: string,
) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO staging_object_deletes SELECT ?,binding,object_key,incarnation,?, ?,NULL FROM staging_objects WHERE binding||':'||object_key=? AND incarnation=? AND cleanup_id=? AND state='deleting'`,
    )
    .bind(token, id, at, key, incarnation, id);
}
export function finishStagingDelete(db: CatalogueStore, key: string, incarnation: number, token: string, at: string) {
  const sql = repositoryStatements(db);
  return [
    sql
      .prepare(`UPDATE staging_object_deletes SET completed_at=? WHERE token=? AND completed_at IS NULL`)
      .bind(at, token),
    sql
      .prepare(`UPDATE staging_objects SET state='deleted' WHERE binding||':'||object_key=? AND incarnation=? AND state='deleting'
 AND NOT EXISTS(SELECT 1 FROM staging_object_deletes WHERE binding||':'||object_key=? AND incarnation=? AND completed_at IS NULL)`)
      .bind(key, incarnation, key, incarnation),
  ];
}
