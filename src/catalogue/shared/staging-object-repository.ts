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
      .prepare(
        `INSERT INTO staging_objects(binding,object_key) VALUES (?,?)
 ON CONFLICT(binding,object_key) DO UPDATE SET state='available',incarnation=incarnation+1,cleanup_id=NULL,reserved_at=NULL
 WHERE staging_objects.state='deleted'`,
      )
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
    .prepare(
      `UPDATE staging_object_writes SET completed_at=? WHERE token=? AND binding=? AND object_key=? AND completed_at IS NULL
 AND incarnation=(SELECT incarnation FROM staging_objects WHERE binding=? AND object_key=?)`,
    )
    .bind(at, token, binding, key, binding, key);
}

/** Four object identities and their independent writer tickets enter one transaction.
 * Keep the bounded input outermost so each ticket uses the complete object primary key. */
export function beginStagingWrites(
  db: CatalogueStore,
  preparation: string,
  binding: StagingBinding,
  writes: { key: string; token: string }[],
  at: string,
) {
  if (writes.length < 1 || writes.length > 4) throw new Error("Staging writes require one to four objects.");
  const sql = repositoryStatements(db);
  const identities = JSON.stringify(writes.map(({ key, token }) => ({ key, token })));
  return [
    sql
      .prepare(
        `INSERT INTO staging_objects(binding,object_key)
 SELECT ?1,json_extract(value,'$.key') FROM json_each(?2) WHERE true
 ON CONFLICT(binding,object_key) DO UPDATE SET state='available',incarnation=incarnation+1,cleanup_id=NULL,reserved_at=NULL
 WHERE staging_objects.state='deleted'`,
      )
      .bind(binding, identities),
    sql
      .prepare(
        `INSERT INTO staging_object_writes
 SELECT json_extract(write.value,'$.token'),COALESCE((SELECT preparation_id FROM game_candidates WHERE id=?1),?1),
 ?2,object.object_key,object.incarnation,?4,NULL FROM json_each(?3) write
 CROSS JOIN staging_objects object ON object.binding=?2 AND object.object_key=json_extract(write.value,'$.key')`,
      )
      .bind(preparation, binding, identities, at),
  ];
}
export function finishStagingWrites(db: CatalogueStore, tokens: string[], at: string) {
  if (tokens.length < 1 || tokens.length > 4) throw new Error("Staging completion requires one to four tickets.");
  return repositoryStatements(db)
    .prepare(
      `UPDATE staging_object_writes SET completed_at=? WHERE token IN (SELECT value FROM json_each(?)) AND completed_at IS NULL`,
    )
    .bind(at, JSON.stringify(tokens));
}

export function registeredStagingKeysStatement(db: CatalogueStore, binding: StagingBinding, keys: string[]) {
  if (keys.length < 1 || keys.length > 4) throw new Error("Staging presence requires one to four keys.");
  return repositoryStatements(db)
    .prepare(
      `SELECT object_key FROM staging_objects WHERE binding=? AND object_key IN (SELECT value FROM json_each(?))`,
    )
    .bind(binding, JSON.stringify(keys));
}
