import { type CatalogueStore, repositoryStatements } from "../../../../src/catalogue/shared";

export function retainedPublicComponent(db: CatalogueStore, candidateId: string) {
  return repositoryStatements(db)
    .prepare(
      "SELECT object_key,sha256,byte_length FROM publication_export_components WHERE candidate_id=? ORDER BY ordinal LIMIT 1",
    )
    .bind(candidateId);
}
