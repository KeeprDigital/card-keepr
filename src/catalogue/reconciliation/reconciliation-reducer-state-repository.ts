import { type CatalogueStore, repositoryStatements } from "../shared";

export function reducerStateStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  key: string,
  before: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_reducer_state
    WHERE ingestion_run_id = ? AND namespace = ? AND key_digest = ? AND observation_ordinal < ?
    ORDER BY observation_ordinal DESC LIMIT 1`)
    .bind(runId, namespace, key, before);
}

export function retainReducerStateStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  key: string,
  ordinal: number,
  content: string,
  sha256: string,
  groupDigest: string | null,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_reducer_state
    (ingestion_run_id, namespace, key_digest, observation_ordinal, content, sha256, group_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(runId, namespace, key, ordinal, content, sha256, groupDigest);
}

export function exactReducerStateStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  key: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(`SELECT content, sha256 FROM reconciliation_reducer_state
    WHERE ingestion_run_id = ? AND namespace = ? AND key_digest = ? AND observation_ordinal = ?`)
    .bind(runId, namespace, key, ordinal);
}

export function nextReducerGroupStateStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  groupDigest: string,
  before: number,
  after: string,
) {
  return repositoryStatements(database)
    .prepare(`SELECT state.key_digest, state.content, state.sha256
    FROM reconciliation_reducer_state state
    WHERE state.ingestion_run_id = ? AND state.namespace = ? AND state.group_digest = ?
      AND state.key_digest > ? AND state.observation_ordinal < ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state later
        WHERE later.ingestion_run_id = state.ingestion_run_id AND later.namespace = state.namespace
          AND later.key_digest = state.key_digest AND later.observation_ordinal > state.observation_ordinal
          AND later.observation_ordinal < ?)
    ORDER BY state.key_digest LIMIT 1`)
    .bind(runId, namespace, groupDigest, after, before, before);
}
