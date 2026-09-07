import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainEvidenceSelectionStatement(
  database: CatalogueStore,
  preparationId: string,
  requestId: string,
  sequence: number,
  content: string,
  digest: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_evidence_selection
    (preparation_id, request_id, sequence_number, content, sha256) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (preparation_id, request_id) DO NOTHING`)
    .bind(preparationId, requestId, sequence, content, digest);
}
export function evidenceSelectionRequestStatement(database: CatalogueStore, preparationId: string, requestId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_evidence_selection
    WHERE preparation_id = ? AND request_id = ?`)
    .bind(preparationId, requestId);
}
export function nextEvidenceSelectionStatement(
  database: CatalogueStore,
  preparationId: string,
  sequence: number,
  requestId: string,
  includeCurrent: boolean,
) {
  return repositoryStatements(database)
    .prepare(`SELECT request_id, sequence_number, content, sha256 FROM reconciliation_evidence_selection
    WHERE preparation_id = ? AND ((sequence_number, request_id) > (?, ?) OR (? = 1 AND sequence_number = ? AND request_id = ?))
    ORDER BY sequence_number, request_id LIMIT 1`)
    .bind(preparationId, sequence, requestId, includeCurrent ? 1 : 0, sequence, requestId);
}
