import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainObservationOriginStatement(
  database: CatalogueStore,
  preparationId: string,
  id: string,
  setId: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_observation_origins (preparation_id, observation_id, observation_set_id, source_ordinal)
    VALUES (?, ?, ?, ?) ON CONFLICT (preparation_id, observation_id) DO NOTHING`)
    .bind(preparationId, id, setId, ordinal);
}

export function observationOriginStatement(database: CatalogueStore, preparationId: string, id: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT observation_set_id, source_ordinal FROM reconciliation_observation_origins WHERE preparation_id = ? AND observation_id = ?`,
    )
    .bind(preparationId, id);
}

export function normalizedObservationExistsStatement(database: CatalogueStore, preparationId: string, id: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT 1 AS present FROM reconciliation_normalized_observations WHERE preparation_id = ? AND observation_id = ?`,
    )
    .bind(preparationId, id);
}

export function retainNormalizedObservationStatement(
  database: CatalogueStore,
  preparationId: string,
  id: string,
  content: string,
  sha256: string,
  cardErratumTargetDigest: string | null,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_normalized_observations (preparation_id, observation_id, content, sha256, card_erratum_target_digest)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (preparation_id, observation_id) DO NOTHING`)
    .bind(preparationId, id, content, sha256, cardErratumTargetDigest);
}

export function normalizedObservationStatement(database: CatalogueStore, preparationId: string, id: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT content, sha256, card_erratum_target_digest FROM reconciliation_normalized_observations WHERE preparation_id = ? AND observation_id = ?`,
    )
    .bind(preparationId, id);
}

export function nextNormalizedObservationStatement(
  database: CatalogueStore,
  preparationId: string,
  after: string | null,
) {
  if (after === null)
    return repositoryStatements(database)
      .prepare(`SELECT observation_id, content, sha256 FROM reconciliation_normalized_observations
    WHERE preparation_id = ? ORDER BY observation_id LIMIT 1`)
      .bind(preparationId);
  return repositoryStatements(database)
    .prepare(`SELECT observation_id, content, sha256 FROM reconciliation_normalized_observations
    WHERE preparation_id = ? AND observation_id > ? ORDER BY observation_id LIMIT 1`)
    .bind(preparationId, after);
}

export function nextNormalizedCardErratumStatement(
  database: CatalogueStore,
  preparationId: string,
  digest: string,
  after: string | null,
) {
  return repositoryStatements(database)
    .prepare(`SELECT observation_id, content, sha256
    FROM reconciliation_normalized_observations
    WHERE preparation_id = ? AND card_erratum_target_digest = ? AND (? IS NULL OR observation_id > ?)
    ORDER BY observation_id LIMIT 1`)
    .bind(preparationId, digest, after, after);
}

export function normalizedObservationPageStatement(database: CatalogueStore, preparationId: string, after: string) {
  return repositoryStatements(database)
    .prepare(`WITH RECURSIVE page(observation_id, bytes, records) AS (
      SELECT observation_id, length(CAST(content AS BLOB)) + 1, 1 FROM reconciliation_normalized_observations
      WHERE preparation_id = ? AND observation_id = (SELECT MIN(observation_id) FROM reconciliation_normalized_observations
        WHERE preparation_id = ? AND observation_id > ?)
      UNION ALL
      SELECT next.observation_id, page.bytes + length(CAST(next.content AS BLOB)) + 1, page.records + 1
      FROM page JOIN reconciliation_normalized_observations AS next
        ON next.preparation_id = ? AND next.observation_id = (SELECT MIN(observation_id) FROM reconciliation_normalized_observations
          WHERE preparation_id = ? AND observation_id > page.observation_id)
      WHERE page.records < 500 AND page.bytes + length(CAST(next.content AS BLOB)) + 1 <= 524287
    )
    SELECT retained.observation_id, retained.content, retained.sha256 FROM page
    JOIN reconciliation_normalized_observations AS retained ON retained.preparation_id = ? AND retained.observation_id = page.observation_id
    WHERE page.bytes <= 524287 ORDER BY retained.observation_id`)
    .bind(preparationId, preparationId, after, preparationId, preparationId, preparationId);
}
