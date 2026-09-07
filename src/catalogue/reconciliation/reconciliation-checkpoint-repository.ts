import { type CatalogueStore, repositoryStatements } from "../shared";

export function newestReconciliationCheckpointStatement(database: CatalogueStore, preparationId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT phase, ordinal, sha256, length(CAST(content AS BLOB)) AS byte_length
      FROM reconciliation_checkpoints WHERE preparation_id = ? ORDER BY rowid DESC LIMIT 1`)
    .bind(preparationId);
}

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
    ON CONFLICT (preparation_id, phase, ordinal) DO NOTHING
    RETURNING ordinal, content, sha256`)
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

export function reserveReconciliationWorkAttemptStatement(
  database: CatalogueStore,
  preparationId: string,
  generation: number,
  shardOrdinal: number,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_workflow_budgets
    (preparation_id, generation, shard_ordinal, reserved_calls) VALUES (?, ?, ?, 100)
    ON CONFLICT(preparation_id, generation, shard_ordinal) DO UPDATE
    SET reserved_calls = reserved_calls + 100 WHERE reserved_calls <= 4400
    RETURNING reserved_calls`)
    .bind(preparationId, generation, shardOrdinal);
}
