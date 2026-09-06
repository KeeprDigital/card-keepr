import { type CatalogueStore, repositoryStatements } from "../shared";

export function latestReconciliationCheckpointStatement(database: CatalogueStore, runId: string, phase: string) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, content, sha256 FROM reconciliation_checkpoints
    WHERE ingestion_run_id = ? AND phase = ? ORDER BY ordinal DESC LIMIT 1`)
    .bind(runId, phase);
}
export function exactReconciliationCheckpointStatement(
  database: CatalogueStore,
  runId: string,
  phase: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, content, sha256 FROM reconciliation_checkpoints
    WHERE ingestion_run_id = ? AND phase = ? AND ordinal = ?`)
    .bind(runId, phase, ordinal);
}
export function retainReconciliationCheckpointStatement(
  database: CatalogueStore,
  runId: string,
  phase: string,
  ordinal: number,
  content: string,
  digest: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_checkpoints
    (ingestion_run_id, phase, ordinal, content, sha256) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ingestion_run_id, phase, ordinal) DO NOTHING`)
    .bind(runId, phase, ordinal, content, digest);
}
export function reconciliationCheckpointsStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT phase, ordinal, content, sha256 FROM reconciliation_checkpoints AS checkpoint
    WHERE ingestion_run_id = ? AND ordinal = (SELECT MAX(ordinal) FROM reconciliation_checkpoints AS later
      WHERE later.ingestion_run_id = checkpoint.ingestion_run_id AND later.phase = checkpoint.phase)
    ORDER BY phase`)
    .bind(runId);
}
