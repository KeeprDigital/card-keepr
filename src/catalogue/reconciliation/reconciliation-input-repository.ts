import { type CatalogueStore, repositoryStatements } from "../shared";

export function reconciliationInputManifestStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT input_manifest_digest FROM reconciliation_operations WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function reconciliationInputPartitionStatement(database: CatalogueStore, runId: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare(
      `SELECT kind, content, sha256 FROM reconciliation_input_partitions WHERE ingestion_run_id = ? AND ordinal = ?`,
    )
    .bind(runId, ordinal);
}

export function insertReconciliationInputPartitionStatement(
  database: CatalogueStore,
  runId: string,
  ordinal: number,
  kind: string,
  content: string,
  sha256: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_input_partitions
    (ingestion_run_id, ordinal, kind, content, sha256) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ingestion_run_id, ordinal) DO NOTHING`)
    .bind(runId, ordinal, kind, content, sha256);
}

export function sealReconciliationInputStatement(
  database: CatalogueStore,
  runId: string,
  digest: string,
  count: number,
) {
  return repositoryStatements(database)
    .prepare(`UPDATE reconciliation_operations SET input_manifest_digest = ?
    WHERE ingestion_run_id = ? AND state = 'preparing' AND CASE WHEN
      (input_manifest_digest IS NULL OR input_manifest_digest = ?) AND
      (SELECT count(*) FROM reconciliation_input_partitions WHERE ingestion_run_id = ?) = ?
    THEN 1 ELSE json_extract('{}', 'reconciliation_input_partition_conflict') END`)
    .bind(digest, runId, digest, runId, count);
}

export function reconciliationInputPartitionsStatement(database: CatalogueStore, runId: string, after: number) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, kind, sha256,
    length(CAST(content AS BLOB)) AS byte_length, json_array_length(content) AS record_count
    FROM reconciliation_input_partitions WHERE ingestion_run_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 100`)
    .bind(runId, after);
}
export function nextReconciliationInputKindStatement(
  database: CatalogueStore,
  runId: string,
  kind: string,
  after: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, content, sha256 FROM reconciliation_input_partitions
    WHERE ingestion_run_id = ? AND kind = ? AND ordinal > ? ORDER BY ordinal LIMIT 1`)
    .bind(runId, kind, after);
}
