import { type CatalogueStore, repositoryStatements } from "./catalogue-store-repository";
// Prepared statements only; callers own execution and atomic batch composition.

export function persistReconciliationPayloadChunkStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; kind: string; index: number; content: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_payload_chunks (
           ingestion_run_id, payload_kind, chunk_index, content
         ) VALUES (?, ?, ?, ?)`)
    .bind(input.runId, input.kind, input.index, input.content);
}

export function retainedReconciliationPayloadChunksStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; kind: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT chunk_index, content
       FROM reconciliation_payload_chunks
       WHERE ingestion_run_id = ? AND payload_kind = ?
       ORDER BY chunk_index`)
    .bind(input.runId, input.kind);
}
