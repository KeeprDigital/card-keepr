import { type CatalogueStore, repositoryStatements } from "../shared";

export function preparationBatchStatement(database: CatalogueStore, runId: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare(`SELECT kind, sha256 FROM reconciliation_preparation_batches
    WHERE ingestion_run_id = ? AND ordinal = ?`)
    .bind(runId, ordinal);
}

export function recordPreparationBatchStatement(
  database: CatalogueStore,
  runId: string,
  ordinal: number,
  kind: string,
  sha256: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_preparation_batches
    (ingestion_run_id, ordinal, kind, sha256) VALUES (?, ?, ?, ?)`)
    .bind(runId, ordinal, kind, sha256);
}

export function preparationCompleteGuard(database: CatalogueStore, runId: string, count: number) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN
    EXISTS (SELECT 1 FROM (
      SELECT content FROM reconciliation_checkpoints WHERE ingestion_run_id = ? AND phase = 'candidate_staging'
      ORDER BY ordinal DESC LIMIT 1
    ) WHERE json_extract(content, '$.stage') = 'complete' AND json_extract(content, '$.ordinal') = ?)
    THEN 1 ELSE json_extract('{}', 'reconciliation_preparation_incomplete') END`)
    .bind(runId, count);
}
