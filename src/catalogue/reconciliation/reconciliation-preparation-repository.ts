import { type CatalogueStore, repositoryStatements } from "../shared";

export function preparationBatchStatement(database: CatalogueStore, preparationId: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare(`SELECT kind, sha256 FROM reconciliation_preparation_batches
    WHERE preparation_id = ? AND ordinal = ?`)
    .bind(preparationId, ordinal);
}

export function recordPreparationBatchStatement(
  database: CatalogueStore,
  preparationId: string,
  ordinal: number,
  kind: string,
  sha256: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_preparation_batches
    (preparation_id, ordinal, kind, sha256) VALUES (?, ?, ?, ?)`)
    .bind(preparationId, ordinal, kind, sha256);
}

export function preparationCompleteGuard(database: CatalogueStore, preparationId: string, count: number) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN
    EXISTS (SELECT 1 FROM (
      SELECT content FROM reconciliation_checkpoints WHERE preparation_id = ? AND phase = 'candidate_staging'
      ORDER BY ordinal DESC LIMIT 1
    ) WHERE json_extract(content, '$.stage') = 'complete' AND json_extract(content, '$.ordinal') = ?)
    THEN 1 ELSE json_extract('{}', 'reconciliation_preparation_incomplete') END`)
    .bind(preparationId, count);
}
