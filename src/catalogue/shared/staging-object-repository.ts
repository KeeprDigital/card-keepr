import { type CatalogueStore, repositoryStatements } from "./catalogue-store-repository";

export type StagingBinding = "PRINTING_IMAGES" | "CATALOGUE_EXPORTS";
export function beginStagingWrite(
  db: CatalogueStore,
  preparation: string,
  binding: StagingBinding,
  key: string,
  token: string,
  at: string,
) {
  const sql = repositoryStatements(db);
  return [
    sql
      .prepare(`INSERT INTO staging_objects(binding,object_key) VALUES (?,?)
 ON CONFLICT(binding,object_key) DO UPDATE SET state='available',incarnation=incarnation+1,cleanup_id=NULL,reserved_at=NULL
 WHERE staging_objects.state='deleted'`)
      .bind(binding, key),
    sql
      .prepare(
        `INSERT INTO staging_object_writes SELECT ?,COALESCE((SELECT preparation_id FROM game_candidates WHERE id=?),?),?,?,incarnation,?,NULL FROM staging_objects WHERE binding=? AND object_key=?`,
      )
      .bind(token, preparation, preparation, binding, key, at, binding, key),
  ];
}
export function finishStagingWrite(db: CatalogueStore, token: string, at: string) {
  return repositoryStatements(db)
    .prepare(`UPDATE staging_object_writes SET completed_at=? WHERE token=? AND completed_at IS NULL`)
    .bind(at, token);
}

export function finishObservedStagingWrite(
  db: CatalogueStore,
  binding: StagingBinding,
  key: string,
  token: string,
  at: string,
) {
  return repositoryStatements(db)
    .prepare(`UPDATE staging_object_writes SET completed_at=? WHERE token=? AND binding=? AND object_key=? AND completed_at IS NULL
 AND incarnation=(SELECT incarnation FROM staging_objects WHERE binding=? AND object_key=?)`)
    .bind(at, token, binding, key, binding, key);
}
