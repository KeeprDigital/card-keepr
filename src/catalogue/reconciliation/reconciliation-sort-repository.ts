import { type CatalogueStore, repositoryStatements } from "../shared";

export function sortBatchStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  pass: number,
  run: number,
  batch: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_sort_batches
    WHERE ingestion_run_id = ? AND namespace = ? AND pass = ? AND run_ordinal = ? AND batch_ordinal = ?`)
    .bind(runId, namespace, pass, run, batch);
}
export function retainSortBatchStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  pass: number,
  run: number,
  batch: number,
  content: string,
  sha256: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_sort_batches
    (ingestion_run_id, namespace, pass, run_ordinal, batch_ordinal, content, sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING content, sha256`)
    .bind(runId, namespace, pass, run, batch, content, sha256);
}
