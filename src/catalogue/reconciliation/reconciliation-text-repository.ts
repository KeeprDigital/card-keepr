import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainReconciliationTextStatement(
  database: CatalogueStore,
  preparationId: string,
  sha256: string,
  ordinal: number,
  content: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_text_chunks (preparation_id, sha256, ordinal, content)
    VALUES (?, ?, ?, ?) ON CONFLICT (preparation_id, sha256, ordinal) DO NOTHING`)
    .bind(preparationId, sha256, ordinal, content);
}

export function reconciliationTextStatement(
  database: CatalogueStore,
  preparationId: string,
  sha256: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT content FROM reconciliation_text_chunks WHERE preparation_id = ? AND sha256 = ? AND ordinal = ?`)
    .bind(preparationId, sha256, ordinal);
}

export function reconciliationTextPageStatement(
  database: CatalogueStore,
  preparationId: string,
  sha256: string,
  ordinal: number,
  count: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, content FROM (
    SELECT ordinal, content, SUM(length(CAST(json_quote(content) AS BLOB))) OVER (ORDER BY ordinal) AS bytes FROM (
      SELECT ordinal, content FROM reconciliation_text_chunks
      WHERE preparation_id = ? AND sha256 = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal LIMIT 16
    )
  ) WHERE bytes <= 512000 ORDER BY ordinal`)
    .bind(preparationId, sha256, ordinal, count);
}
