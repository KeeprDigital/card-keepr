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

export function nextLatestReducerStateStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  through: number,
  after: string,
) {
  return repositoryStatements(database)
    .prepare(`SELECT state.key_digest, state.content, state.sha256
    FROM reconciliation_reducer_state state
    WHERE state.ingestion_run_id = ? AND state.namespace = ?
      AND state.key_digest > ? AND state.observation_ordinal <= ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state later
        WHERE later.ingestion_run_id = state.ingestion_run_id AND later.namespace = state.namespace
          AND later.key_digest = state.key_digest AND later.observation_ordinal > state.observation_ordinal
          AND later.observation_ordinal <= ?)
    ORDER BY state.key_digest LIMIT 1`)
    .bind(runId, namespace, after, through, through);
}

export function nextReducerCardReferenceStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  group: string,
  before: number,
  after: string,
) {
  return repositoryStatements(database)
    .prepare(`SELECT state.key_digest,
    json_extract(state.content, '$.value.id') AS id,
    COALESCE(json_extract(state.content, '$.value.identity_kind'), json_extract(state.content, '$.value.official_identity.kind')) AS identity_kind,
    (SELECT min(first.observation_ordinal) FROM reconciliation_reducer_state first
      WHERE first.ingestion_run_id = state.ingestion_run_id AND first.namespace = state.namespace AND first.key_digest = state.key_digest) AS first_ordinal
    FROM reconciliation_reducer_state state
    WHERE state.ingestion_run_id = ? AND state.namespace = ? AND state.group_digest = ?
      AND state.key_digest > ? AND state.observation_ordinal < ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state later
        WHERE later.ingestion_run_id = state.ingestion_run_id AND later.namespace = state.namespace
          AND later.key_digest = state.key_digest AND later.observation_ordinal > state.observation_ordinal
          AND later.observation_ordinal < ?)
    ORDER BY state.key_digest LIMIT 1`)
    .bind(runId, namespace, group, after, before, before);
}

export function nextReducerEntityStateStatement(
  database: CatalogueStore,
  runId: string,
  namespace: string,
  ordinal: number,
  after: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT state.content, state.sha256,
    json_extract(state.content, '$.value.id') AS entity_id
    FROM reconciliation_reducer_state AS state
    WHERE state.ingestion_run_id = ? AND state.namespace = ? AND state.observation_ordinal <= ?
      AND json_extract(state.content, '$.value.id') > ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state AS later
        WHERE later.ingestion_run_id = state.ingestion_run_id AND later.namespace = state.namespace
          AND later.key_digest = state.key_digest AND later.observation_ordinal > state.observation_ordinal
          AND later.observation_ordinal <= ?)
    ORDER BY json_extract(state.content, '$.value.id') LIMIT 1`)
    .bind(runId, namespace, ordinal, after, ordinal);
}
