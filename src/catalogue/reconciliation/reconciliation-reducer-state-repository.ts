import { type CatalogueStore, repositoryStatements } from "../shared";

/** Left joins retain missing keys; the byte bound lets callers fall back without buffering large matches. */
export function reducerStateLookupPageStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  requests: { digest: string; before: number }[],
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT request_ordinal, content, sha256 FROM (
    SELECT requested.key AS request_ordinal, state.content, state.sha256,
      sum(COALESCE(length(CAST(state.content AS BLOB)), 0)) OVER (ORDER BY CAST(requested.key AS INTEGER)) AS bytes
    FROM json_each(?3) AS requested LEFT JOIN reconciliation_reducer_state AS state
      ON state.preparation_id = ?1 AND state.namespace = ?2
      AND state.key_digest = json_extract(requested.value, '$.digest')
      AND state.observation_ordinal = (SELECT max(latest.observation_ordinal) FROM reconciliation_reducer_state AS latest
        WHERE latest.preparation_id = ?1 AND latest.namespace = ?2 AND latest.key_digest = state.key_digest
          AND latest.observation_ordinal < json_extract(requested.value, '$.before'))
  ) WHERE bytes <= 131072 ORDER BY CAST(request_ordinal AS INTEGER)`,
    )
    .bind(preparationId, namespace, JSON.stringify(requests));
}

export function reducerStateStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  key: string,
  before: number,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT content, sha256 FROM reconciliation_reducer_state
    WHERE preparation_id = ? AND namespace = ? AND key_digest = ? AND observation_ordinal < ?
    ORDER BY observation_ordinal DESC LIMIT 1`,
    )
    .bind(preparationId, namespace, key, before);
}

export function retainReducerStateStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  key: string,
  ordinal: number,
  content: string,
  sha256: string,
  groupDigest: string | null,
) {
  return repositoryStatements(database)
    .prepare(
      `INSERT INTO reconciliation_reducer_state
    (preparation_id, namespace, key_digest, observation_ordinal, content, sha256, group_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING content, sha256`,
    )
    .bind(preparationId, namespace, key, ordinal, content, sha256, groupDigest);
}

export function exactReducerStateStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  key: string,
  ordinal: number,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT content, sha256 FROM reconciliation_reducer_state
    WHERE preparation_id = ? AND namespace = ? AND key_digest = ? AND observation_ordinal = ?`,
    )
    .bind(preparationId, namespace, key, ordinal);
}

/** Conflict verification returns only an exact expected effect, bounding replay response bytes. */
export function matchingReducerStateStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  key: string,
  ordinal: number,
  content: string,
  sha256: string,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT content, sha256 FROM reconciliation_reducer_state
    WHERE preparation_id = ? AND namespace = ? AND key_digest = ? AND observation_ordinal = ?
      AND content = ? AND sha256 = ?`,
    )
    .bind(preparationId, namespace, key, ordinal, content, sha256);
}

export function nextReducerGroupStateStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  groupDigest: string,
  before: number,
  after: string,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT key_digest, content, sha256 FROM (SELECT *,
      sum(length(CAST(content AS BLOB))) OVER (ORDER BY key_digest) AS bytes FROM (
    SELECT state.key_digest, state.content, state.sha256
    FROM reconciliation_reducer_state state
    WHERE state.preparation_id = ? AND state.namespace = ? AND state.group_digest = ?
      AND state.key_digest > ? AND state.observation_ordinal < ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state later
        WHERE later.preparation_id = state.preparation_id AND later.namespace = state.namespace
          AND later.key_digest = state.key_digest AND later.observation_ordinal > state.observation_ordinal
          AND later.observation_ordinal < ?)
    ORDER BY state.key_digest LIMIT 16)) WHERE bytes <= 524288 ORDER BY key_digest`,
    )
    .bind(preparationId, namespace, groupDigest, after, before, before);
}

export function nextLatestReducerStateStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  through: number,
  after: string,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT key_digest, content, sha256 FROM (SELECT *,
      sum(length(CAST(content AS BLOB))) OVER (ORDER BY key_digest) AS bytes FROM (
    SELECT state.key_digest, state.content, state.sha256
    FROM reconciliation_reducer_state state
    WHERE state.preparation_id = ? AND state.namespace = ?
      AND state.key_digest > ? AND state.observation_ordinal <= ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state later
        WHERE later.preparation_id = state.preparation_id AND later.namespace = state.namespace
          AND later.key_digest = state.key_digest AND later.observation_ordinal > state.observation_ordinal
          AND later.observation_ordinal <= ?)
    ORDER BY state.key_digest LIMIT 16)) WHERE bytes <= 524288 ORDER BY key_digest`,
    )
    .bind(preparationId, namespace, after, through, through);
}

export function nextReducerCardReferenceStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  group: string,
  before: number,
  after: string,
  unknownOnly = false,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT state.key_digest,
    json_extract(state.content, '$.value.id') AS id,
    COALESCE(json_extract(state.content, '$.value.identity_kind'), json_extract(state.content, '$.value.official_identity.kind')) AS identity_kind,
    (SELECT min(first.observation_ordinal) FROM reconciliation_reducer_state first
      WHERE first.preparation_id = state.preparation_id AND first.namespace = state.namespace AND first.key_digest = state.key_digest) AS first_ordinal
    FROM reconciliation_reducer_state state
    WHERE state.preparation_id = ? AND state.namespace = ? AND state.group_digest = ?
      ${unknownOnly ? "AND json_extract(state.content, '$.value.identity_kind') = 'unknown'" : ""}
      AND state.key_digest > ? AND state.observation_ordinal < ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state later
        WHERE later.preparation_id = state.preparation_id AND later.namespace = state.namespace
          AND later.key_digest = state.key_digest AND later.observation_ordinal > state.observation_ordinal
          AND later.observation_ordinal < ?)
    ORDER BY state.key_digest LIMIT 1`,
    )
    .bind(preparationId, namespace, group, after, before, before);
}

export function unknownCardReferencePresentStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  before: number,
) {
  return repositoryStatements(database)
    .prepare(
      `SELECT 1 AS present FROM reconciliation_reducer_state
      WHERE preparation_id = ? AND namespace = ? AND observation_ordinal < ?
        AND group_digest IS NOT NULL AND json_extract(content, '$.value.identity_kind') = 'unknown'
      LIMIT 1`,
    )
    .bind(preparationId, namespace, before);
}

export function nextReducerEntityStateStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  ordinal: number,
  after: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `WITH candidates AS (SELECT state.content, state.sha256,
    json_extract(state.content, '$.value.id') AS entity_id
    FROM reconciliation_reducer_state AS state
    WHERE state.preparation_id = ? AND state.namespace = ? AND state.observation_ordinal <= ?
      AND json_extract(state.content, '$.value.id') > ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state AS later
        WHERE later.preparation_id = state.preparation_id AND later.namespace = state.namespace
          AND later.key_digest = state.key_digest AND later.observation_ordinal > state.observation_ordinal
          AND later.observation_ordinal <= ?)
    ORDER BY json_extract(state.content, '$.value.id') LIMIT 16),
    bounded AS (SELECT content, sha256, entity_id,
      sum(length(CAST(content AS BLOB))) OVER (ORDER BY entity_id) AS retained_bytes FROM candidates)
    SELECT content, sha256, entity_id FROM bounded WHERE retained_bytes <= 524288 ORDER BY entity_id`,
    )
    .bind(preparationId, namespace, ordinal, after, ordinal);
}

export function nextReducerInsertionStateStatement(
  database: CatalogueStore,
  preparationId: string,
  namespace: string,
  through: number,
  after: number,
) {
  return repositoryStatements(database)
    .prepare(
      `WITH candidates AS (
    SELECT first.observation_ordinal AS first_ordinal, latest.content, latest.sha256
    FROM reconciliation_reducer_state AS first
    JOIN reconciliation_reducer_state AS latest ON latest.preparation_id = first.preparation_id
      AND latest.namespace = first.namespace AND latest.key_digest = first.key_digest
    WHERE first.preparation_id = ? AND first.namespace = ? AND first.observation_ordinal > ?
      AND first.observation_ordinal <= ? AND latest.observation_ordinal <= ?
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state older WHERE older.preparation_id = first.preparation_id
        AND older.namespace = first.namespace AND older.key_digest = first.key_digest AND older.observation_ordinal < first.observation_ordinal)
      AND NOT EXISTS (SELECT 1 FROM reconciliation_reducer_state newer WHERE newer.preparation_id = latest.preparation_id
        AND newer.namespace = latest.namespace AND newer.key_digest = latest.key_digest AND newer.observation_ordinal > latest.observation_ordinal
        AND newer.observation_ordinal <= ?)
    ORDER BY first.observation_ordinal LIMIT 16), bounded AS (
      SELECT *, sum(length(CAST(content AS BLOB))) OVER (ORDER BY first_ordinal) AS bytes FROM candidates)
    SELECT content, sha256, first_ordinal FROM bounded WHERE bytes <= 524288 ORDER BY first_ordinal`,
    )
    .bind(preparationId, namespace, after, through, through, through);
}
