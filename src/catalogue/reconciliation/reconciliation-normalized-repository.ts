import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainObservationOriginStatement(
  database: CatalogueStore,
  runId: string,
  id: string,
  setId: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_observation_origins (ingestion_run_id, observation_id, observation_set_id, source_ordinal)
    VALUES (?, ?, ?, ?) ON CONFLICT (ingestion_run_id, observation_id) DO NOTHING`)
    .bind(runId, id, setId, ordinal);
}

export function observationOriginStatement(database: CatalogueStore, runId: string, id: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT observation_set_id, source_ordinal FROM reconciliation_observation_origins WHERE ingestion_run_id = ? AND observation_id = ?`,
    )
    .bind(runId, id);
}

export function normalizedObservationExistsStatement(database: CatalogueStore, runId: string, id: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT 1 AS present FROM reconciliation_normalized_observations WHERE ingestion_run_id = ? AND observation_id = ?`,
    )
    .bind(runId, id);
}

export function retainNormalizedObservationStatement(
  database: CatalogueStore,
  runId: string,
  id: string,
  content: string,
  sha256: string,
  cardErratumTargetDigest: string | null,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_normalized_observations (ingestion_run_id, observation_id, content, sha256, card_erratum_target_digest)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (ingestion_run_id, observation_id) DO NOTHING`)
    .bind(runId, id, content, sha256, cardErratumTargetDigest);
}

export function normalizedObservationStatement(database: CatalogueStore, runId: string, id: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT content, sha256, card_erratum_target_digest FROM reconciliation_normalized_observations WHERE ingestion_run_id = ? AND observation_id = ?`,
    )
    .bind(runId, id);
}

export function nextNormalizedObservationStatement(database: CatalogueStore, runId: string, after: string | null) {
  if (after === null)
    return repositoryStatements(database)
      .prepare(`SELECT observation_id, content, sha256 FROM reconciliation_normalized_observations
    WHERE ingestion_run_id = ? ORDER BY observation_id LIMIT 1`)
      .bind(runId);
  return repositoryStatements(database)
    .prepare(`SELECT observation_id, content, sha256 FROM reconciliation_normalized_observations
    WHERE ingestion_run_id = ? AND observation_id > ? ORDER BY observation_id LIMIT 1`)
    .bind(runId, after);
}

export function nextNormalizedCardErratumStatement(
  database: CatalogueStore,
  runId: string,
  digest: string,
  after: string | null,
) {
  return repositoryStatements(database)
    .prepare(`SELECT observation_id, content, sha256
    FROM reconciliation_normalized_observations
    WHERE ingestion_run_id = ? AND card_erratum_target_digest = ? AND (? IS NULL OR observation_id > ?)
    ORDER BY observation_id LIMIT 1`)
    .bind(runId, digest, after, after);
}

export function normalizedObservationPageStatement(database: CatalogueStore, runId: string, after: string) {
  return repositoryStatements(database)
    .prepare(`WITH RECURSIVE page(observation_id, bytes, records) AS (
      SELECT observation_id, length(CAST(content AS BLOB)) + 1, 1 FROM reconciliation_normalized_observations
      WHERE ingestion_run_id = ? AND observation_id = (SELECT MIN(observation_id) FROM reconciliation_normalized_observations
        WHERE ingestion_run_id = ? AND observation_id > ?)
      UNION ALL
      SELECT next.observation_id, page.bytes + length(CAST(next.content AS BLOB)) + 1, page.records + 1
      FROM page JOIN reconciliation_normalized_observations AS next
        ON next.ingestion_run_id = ? AND next.observation_id = (SELECT MIN(observation_id) FROM reconciliation_normalized_observations
          WHERE ingestion_run_id = ? AND observation_id > page.observation_id)
      WHERE page.records < 500 AND page.bytes + length(CAST(next.content AS BLOB)) + 1 <= 524287
    )
    SELECT retained.observation_id, retained.content, retained.sha256 FROM page
    JOIN reconciliation_normalized_observations AS retained ON retained.ingestion_run_id = ? AND retained.observation_id = page.observation_id
    WHERE page.bytes <= 524287 ORDER BY retained.observation_id`)
    .bind(runId, runId, after, runId, runId, runId);
}
