import { type CatalogueStore, repositoryStatements } from "../shared";

export function reconciliationInputManifestStatement(database: CatalogueStore, preparationId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT input_manifest_digest FROM reconciliation_operations WHERE id = ?`)
    .bind(preparationId);
}

export function reconciliationInputPartitionStatement(
  database: CatalogueStore,
  preparationId: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT kind, content, sha256 FROM reconciliation_input_partitions WHERE preparation_id = ? AND ordinal = ?`,
    )
    .bind(preparationId, ordinal);
}

export function insertReconciliationInputPartitionStatement(
  database: CatalogueStore,
  preparationId: string,
  ordinal: number,
  kind: string,
  content: string,
  sha256: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_input_partitions
    (preparation_id, ordinal, kind, content, sha256) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (preparation_id, ordinal) DO NOTHING`)
    .bind(preparationId, ordinal, kind, content, sha256);
}

export function sealReconciliationInputStatement(
  database: CatalogueStore,
  preparationId: string,
  digest: string,
  count: number,
) {
  return repositoryStatements(database)
    .prepare(`UPDATE reconciliation_operations SET input_manifest_digest = ?
    WHERE id = ? AND state = 'preparing' AND CASE WHEN
      (input_manifest_digest IS NULL OR input_manifest_digest = ?) AND
      (SELECT count(*) FROM reconciliation_input_partitions WHERE preparation_id = ?) = ?
    THEN 1 ELSE json_extract('{}', 'reconciliation_input_partition_conflict') END`)
    .bind(digest, preparationId, digest, preparationId, count);
}

export function reconciliationInputPartitionsStatement(database: CatalogueStore, preparationId: string, after: number) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, kind, sha256,
    length(CAST(content AS BLOB)) AS byte_length, json_array_length(content) AS record_count
    FROM reconciliation_input_partitions WHERE preparation_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 100`)
    .bind(preparationId, after);
}
export function nextReconciliationInputKindStatement(
  database: CatalogueStore,
  preparationId: string,
  kind: string,
  after: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT ordinal, content, sha256 FROM reconciliation_input_partitions
    WHERE preparation_id = ? AND kind = ? AND ordinal > ? ORDER BY ordinal LIMIT 1`)
    .bind(preparationId, kind, after);
}
