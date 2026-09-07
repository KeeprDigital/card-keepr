import { type CatalogueStore, repositoryStatements } from "../shared";

export function sourceByteChunkStatement(database: CatalogueStore, run: string, set: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_source_byte_chunks
    WHERE ingestion_run_id = ? AND observation_set_id = ? AND ordinal = ?`)
    .bind(run, set, ordinal);
}
export function retainSourceByteChunkStatement(
  database: CatalogueStore,
  run: string,
  set: string,
  ordinal: number,
  content: string,
  digest: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_source_byte_chunks
    (ingestion_run_id, observation_set_id, ordinal, content, sha256) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ingestion_run_id, observation_set_id, ordinal) DO NOTHING`)
    .bind(run, set, ordinal, content, digest);
}
export function sourceDocumentHeaderStatement(database: CatalogueStore, run: string, set: string) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_source_documents
    WHERE ingestion_run_id = ? AND observation_set_id = ?`)
    .bind(run, set);
}
export function retainSourceDocumentHeaderStatement(
  database: CatalogueStore,
  run: string,
  set: string,
  content: string,
  digest: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_source_documents
    (ingestion_run_id, observation_set_id, content, sha256) VALUES (?, ?, ?, ?)
    ON CONFLICT(ingestion_run_id, observation_set_id) DO NOTHING`)
    .bind(run, set, content, digest);
}
