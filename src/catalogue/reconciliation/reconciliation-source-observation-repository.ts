import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainSourceObservationStatement(
  database: CatalogueStore,
  runId: string,
  setId: string,
  ordinal: number,
  content: string,
  digest: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_source_observations
    (ingestion_run_id, observation_set_id, ordinal, content, sha256) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ingestion_run_id, observation_set_id, ordinal) DO NOTHING`)
    .bind(runId, setId, ordinal, content, digest);
}

export function sourceObservationStatement(database: CatalogueStore, runId: string, setId: string, ordinal: number) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_source_observations
    WHERE ingestion_run_id = ? AND observation_set_id = ? AND ordinal = ?`)
    .bind(runId, setId, ordinal);
}
