import { type CatalogueStore, repositoryStatements } from "../shared";

export function latestReconciliationCheckpointStatement(
  database: CatalogueStore,
  preparationId: string,
  phase: string,
) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, content, sha256 FROM reconciliation_checkpoints
    WHERE preparation_id = ? AND phase = ? ORDER BY ordinal DESC LIMIT 1`)
    .bind(preparationId, phase);
}
export function exactReconciliationCheckpointStatement(
  database: CatalogueStore,
  preparationId: string,
  phase: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, content, sha256 FROM reconciliation_checkpoints
    WHERE preparation_id = ? AND phase = ? AND ordinal = ?`)
    .bind(preparationId, phase, ordinal);
}
export function retainReconciliationCheckpointStatement(
  database: CatalogueStore,
  preparationId: string,
  phase: string,
  ordinal: number,
  content: string,
  digest: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_checkpoints
    (preparation_id, phase, ordinal, content, sha256) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (preparation_id, phase, ordinal) DO NOTHING`)
    .bind(preparationId, phase, ordinal, content, digest);
}
export function reconciliationCheckpointsStatement(database: CatalogueStore, preparationId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT phase, ordinal, content, sha256 FROM reconciliation_checkpoints AS checkpoint
    WHERE preparation_id = ? AND ordinal = (SELECT MAX(ordinal) FROM reconciliation_checkpoints AS later
      WHERE later.preparation_id = checkpoint.preparation_id AND later.phase = checkpoint.phase)
    ORDER BY phase`)
    .bind(preparationId);
}
