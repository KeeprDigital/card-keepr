import { type CatalogueStore, repositoryStatements } from "../shared";

export function verifiedDocumentStatement(database: CatalogueStore, runId: string, observationSetId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT provenance_digest, manifest_digest, partition_count
    FROM reconciliation_verified_documents WHERE ingestion_run_id = ? AND observation_set_id = ?`)
    .bind(runId, observationSetId);
}

export function documentPartitionStatement(
  database: CatalogueStore,
  runId: string,
  observationSetId: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT kind, content, sha256 FROM reconciliation_document_partitions
    WHERE ingestion_run_id = ? AND observation_set_id = ? AND ordinal = ?`)
    .bind(runId, observationSetId, ordinal);
}

export function retainDocumentPartitionStatement(
  database: CatalogueStore,
  runId: string,
  observationSetId: string,
  ordinal: number,
  kind: string,
  content: string,
  sha256: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_document_partitions
    (ingestion_run_id, observation_set_id, ordinal, kind, content, sha256) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (ingestion_run_id, observation_set_id, ordinal) DO NOTHING`)
    .bind(runId, observationSetId, ordinal, kind, content, sha256);
}

export function verifyDocumentStatement(
  database: CatalogueStore,
  runId: string,
  observationSetId: string,
  provenance: string,
  digest: string,
  count: number,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_verified_documents
    (ingestion_run_id, observation_set_id, provenance_digest, manifest_digest, partition_count)
    SELECT ?, ?, ?, ?, ? WHERE CASE WHEN (SELECT count(*) FROM reconciliation_document_partitions
      WHERE ingestion_run_id = ? AND observation_set_id = ?) = ? THEN 1 ELSE json_extract('{}', 'document_partition_count_mismatch') END
    ON CONFLICT (ingestion_run_id, observation_set_id) DO NOTHING`)
    .bind(runId, observationSetId, provenance, digest, count, runId, observationSetId, count);
}
