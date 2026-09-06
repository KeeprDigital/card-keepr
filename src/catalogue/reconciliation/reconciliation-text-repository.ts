import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainReconciliationTextStatement(
  database: CatalogueStore,
  runId: string,
  sha256: string,
  ordinal: number,
  content: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_text_chunks (ingestion_run_id, sha256, ordinal, content)
    VALUES (?, ?, ?, ?) ON CONFLICT (ingestion_run_id, sha256, ordinal) DO NOTHING`)
    .bind(runId, sha256, ordinal, content);
}

export function reconciliationTextStatement(database: CatalogueStore, runId: string, sha256: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare(`SELECT content FROM reconciliation_text_chunks WHERE ingestion_run_id = ? AND sha256 = ? AND ordinal = ?`)
    .bind(runId, sha256, ordinal);
}
