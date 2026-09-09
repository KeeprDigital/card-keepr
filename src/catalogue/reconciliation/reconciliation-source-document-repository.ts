import { type CatalogueStore, repositoryStatements } from "../shared";

export function sourceDocumentHeaderStatement(database: CatalogueStore, run: string, set: string) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_source_documents
    WHERE preparation_id = ? AND observation_set_id = ?`)
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
    (preparation_id, observation_set_id, content, sha256) VALUES (?, ?, ?, ?)
    ON CONFLICT(preparation_id, observation_set_id) DO NOTHING`)
    .bind(run, set, content, digest);
}
