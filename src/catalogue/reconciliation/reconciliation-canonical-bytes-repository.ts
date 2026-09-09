import { type CatalogueStore, repositoryStatements } from "../shared";

export function canonicalBytesStatement(database: CatalogueStore, preparationId: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare("SELECT content, sha256 FROM reconciliation_canonical_bytes WHERE preparation_id = ? AND ordinal = ?")
    .bind(preparationId, ordinal);
}

export function retainCanonicalBytesStatement(
  database: CatalogueStore,
  preparationId: string,
  ordinal: number,
  content: string,
  sha256: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_canonical_bytes (preparation_id, ordinal, content, sha256)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING content, sha256`)
    .bind(preparationId, ordinal, content, sha256);
}
