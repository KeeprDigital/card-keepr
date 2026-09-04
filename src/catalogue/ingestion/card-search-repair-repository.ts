import { atomicRepositoryStatement, type CatalogueStore, repositoryStatements } from "../shared";
import { materializeCardSearchChunkStatements } from "./card-search-materialization-repository";
// Named prepared statements; callers retain execution and atomic batch composition.

export function createSearchRepairRequestStatement(
  database: CatalogueStore,
  input: Readonly<{ key: string; targetRevisionId: string; expectedRevisionId: string; requestJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO catalogue_search_repair_requests (
           idempotency_key, target_revision_id,
           expected_current_revision_id, request_json, result_json
         ) VALUES (?, ?, ?, ?, NULL)`)
    .bind(input.key, input.targetRevisionId, input.expectedRevisionId, input.requestJson);
}

export function claimSearchRepairRequestStatement(
  database: CatalogueStore,
  input: Readonly<{ claimToken: string; expiresAt: string; key: string; observedAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_search_repair_requests
       SET claim_token = ?, claim_expires_at = ?
       WHERE idempotency_key = ?
         AND (
           result_json IS NULL
           OR json_extract(result_json, '$.complete') = 0
         )
         AND (
           claim_token IS NULL
           OR claim_expires_at <= ?
         )
         AND EXISTS (
           SELECT 1
           FROM catalogue_state AS state
           WHERE state.singleton = 1
             AND state.current_revision_id =
                   catalogue_search_repair_requests.expected_current_revision_id
         )`)
    .bind(input.claimToken, input.expiresAt, input.key, input.observedAt);
}

export function searchRepairCurrentRevisionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT current_revision_id
         FROM catalogue_state
         WHERE singleton = 1`);
}

export function releaseSearchRepairClaimStatement(
  database: CatalogueStore,
  input: Readonly<{ key: string; claimToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_search_repair_requests
         SET claim_token = NULL, claim_expires_at = NULL
         WHERE idempotency_key = ? AND claim_token = ?
           AND (
             result_json IS NULL
             OR json_extract(result_json, '$.complete') = 0
           )`)
    .bind(input.key, input.claimToken);
}

export function completeSearchRepairRequestStatement(
  database: CatalogueStore,
  input: Readonly<{ resultJson: string; key: string; claimToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_search_repair_requests
       SET result_json = ?, claim_token = NULL, claim_expires_at = NULL
       WHERE idempotency_key = ? AND claim_token = ?
         AND (
           result_json IS NULL
           OR json_extract(result_json, '$.complete') = 0
         )`)
    .bind(input.resultJson, input.key, input.claimToken);
}

export function oversizedSearchRepairCardStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; maximumBytes: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT card_id
       FROM revision_cards
       WHERE catalogue_revision_id = ?
         AND length(CAST(document_json AS BLOB)) > ?
       ORDER BY card_id
       LIMIT 1`)
    .bind(input.revisionId, input.maximumBytes);
}

export function searchRepairRequestStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT idempotency_key, target_revision_id,
              expected_current_revision_id, request_json, result_json,
              claim_token, claim_expires_at
       FROM catalogue_search_repair_requests
       WHERE idempotency_key = ?`)
    .bind(key);
}

export function revisionWithoutSearchProjectionStatement(
  database: CatalogueStore,
  targetRevisionId: string | null,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT revision.id AS catalogue_revision_id
       FROM catalogue_revisions AS revision
       WHERE NOT EXISTS (
           SELECT 1 FROM catalogue_query_revisions AS query
           WHERE query.catalogue_revision_id = revision.id
         )
         AND (? IS NULL OR revision.id = ?)
       ORDER BY revision.id
       LIMIT 1`)
    .bind(targetRevisionId, targetRevisionId);
}

export function createPendingSearchProjectionStatement(
  database: CatalogueStore,
  revisionId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO catalogue_query_revisions (
         catalogue_revision_id, state, repaired_through_card_id,
         repair_card_id, repair_search_offset, repair_term_offset
       ) VALUES (?, 'pending', NULL, NULL, 0, 0)
       ON CONFLICT(catalogue_revision_id) DO NOTHING`)
    .bind(revisionId);
}

export function nextCardToRepairStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; afterCardId: string | null }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT card_id
       FROM revision_cards
       WHERE catalogue_revision_id = ?
         AND (? IS NULL OR card_id > ?)
       ORDER BY card_id
       LIMIT 1`)
    .bind(input.revisionId, input.afterCardId, input.afterCardId);
}

export function completeSearchProjectionStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_query_revisions
         SET state = 'available',
             repaired_through_card_id = NULL,
             repair_card_id = NULL,
             repair_search_offset = 0,
             repair_term_offset = 0
         WHERE catalogue_revision_id = ? AND state = 'pending'`)
    .bind(revisionId);
}

export function createCardQuerySummaryStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; cardId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO revision_card_query_documents (
           catalogue_revision_id, card_id, summary_json, search_text
         )
         SELECT catalogue_revision_id, card_id,
                json_object(
                  'type', COALESCE(
                    json_extract(document_json, '$.data.type'),
                    json_extract(document_json, '$.type')
                  ),
                  'id', COALESCE(
                    json_extract(document_json, '$.data.id'),
                    json_extract(document_json, '$.id')
                  ),
                  'game', COALESCE(
                    json_extract(document_json, '$.data.game'),
                    json_extract(document_json, '$.game')
                  ),
                  'official_identity',
                    COALESCE(
                      json_extract(
                        document_json, '$.data.official_identity'
                      ),
                      json_extract(document_json, '$.official_identity')
                    ),
                  'name', COALESCE(
                    json_extract(document_json, '$.data.name'),
                    json_extract(document_json, '$.name')
                  ),
                  'game_data', COALESCE(
                    json_extract(document_json, '$.data.game_data'),
                    json_extract(document_json, '$.game_data')
                  ),
                  'lifecycle', COALESCE(
                    json_extract(document_json, '$.data.lifecycle'),
                    json_extract(document_json, '$.lifecycle')
                  ),
                  'links', COALESCE(
                    json_extract(document_json, '$.data.links'),
                    json_extract(document_json, '$.links')
                  )
                ),
                ''
         FROM revision_cards
         WHERE catalogue_revision_id = ? AND card_id = ?`)
    .bind(input.revisionId, input.cardId);
}

export function beginCardRepairStatement(
  database: CatalogueStore,
  input: Readonly<{ cardId: string; revisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_query_revisions
         SET repair_card_id = ?,
             repair_search_offset = 0,
             repair_term_offset = 0
         WHERE catalogue_revision_id = ?
           AND state = 'pending'
           AND repair_card_id IS NULL`)
    .bind(input.cardId, input.revisionId);
}

export function cardRepairSourceDocumentStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; cardId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT document_json
     FROM revision_cards
     WHERE catalogue_revision_id = ? AND card_id = ?`)
    .bind(input.revisionId, input.cardId);
}

export function appendRepairedCardSearchTextStatement(
  database: CatalogueStore,
  input: Readonly<{ chunk: string; revisionId: string; cardId: string; expectedOffset: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE revision_card_query_documents
         SET search_text = search_text || ?
         WHERE catalogue_revision_id = ? AND card_id = ?
           AND length(CAST(search_text AS BLOB)) = ?`)
    .bind(input.chunk, input.revisionId, input.cardId, input.expectedOffset);
}

export function advanceCardSearchOffsetStatement(
  database: CatalogueStore,
  input: Readonly<{ nextOffset: number; revisionId: string; cardId: string; expectedOffset: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_query_revisions
         SET repair_search_offset = ?
         WHERE catalogue_revision_id = ?
           AND state = 'pending'
           AND repair_card_id = ?
           AND repair_search_offset = ?
           AND EXISTS (
             SELECT 1
             FROM revision_card_query_documents AS document
             WHERE document.catalogue_revision_id =
                     catalogue_query_revisions.catalogue_revision_id
               AND document.card_id =
                     catalogue_query_revisions.repair_card_id
               AND length(CAST(document.search_text AS BLOB)) = ?
           )`)
    .bind(input.nextOffset, input.revisionId, input.cardId, input.expectedOffset, input.nextOffset);
}

export function insertRepairedCardSearchChunkStatement(
  database: CatalogueStore,
  input: Readonly<{
    revisionId: string;
    cardId: string | null;
    fieldOrdinal: number;
    chunkOrdinal: number;
    searchText: string;
  }>,
): D1PreparedStatement {
  const statement = repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO revision_card_search_chunks (
             catalogue_revision_id, card_id, field_ordinal,
             chunk_ordinal, search_text
           ) VALUES (?, ?, ?, ?, ?)`)
    .bind(input.revisionId, input.cardId, input.fieldOrdinal, input.chunkOrdinal, input.searchText);
  return atomicRepositoryStatement(database, {
    statement,
    after: materializeCardSearchChunkStatements(database, {
      revisionId: input.revisionId,
      chunksJson: JSON.stringify([
        { card_id: input.cardId, field_ordinal: input.fieldOrdinal, chunk_ordinal: input.chunkOrdinal },
      ]),
    }),
  });
}

export function advanceCardSearchChunkOffsetStatement(
  database: CatalogueStore,
  input: Readonly<{ nextOffset: number; revisionId: string; cardId: string; expectedOffset: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_query_revisions
         SET repair_term_offset = ?
         WHERE catalogue_revision_id = ?
           AND state = 'pending'
           AND repair_card_id = ?
           AND repair_term_offset = ?`)
    .bind(input.nextOffset, input.revisionId, input.cardId, input.expectedOffset);
}

export function completeCardSearchRepairStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; cardId: string; expectedSearchBytes: number; expectedChunkCount: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_query_revisions
     SET repaired_through_card_id = repair_card_id,
         repair_card_id = NULL,
         repair_search_offset = 0,
         repair_term_offset = 0
     WHERE catalogue_revision_id = ?
       AND state = 'pending'
       AND repair_card_id = ?
       AND repair_search_offset = ?
       AND repair_term_offset = ?`)
    .bind(input.revisionId, input.cardId, input.expectedSearchBytes, input.expectedChunkCount);
}

export function pendingSearchProjectionStatement(
  database: CatalogueStore,
  targetRevisionId: string | null,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT catalogue_revision_id, repaired_through_card_id,
            repair_card_id, repair_search_offset, repair_term_offset
     FROM catalogue_query_revisions
     WHERE state = 'pending'
       AND (? IS NULL OR catalogue_revision_id = ?)
     ORDER BY catalogue_revision_id
     LIMIT 1`)
    .bind(targetRevisionId, targetRevisionId);
}

export function searchRepairProgressStatement(
  database: CatalogueStore,
  targetRevisionId: string | null,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
       sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
       sum(CASE WHEN state = 'available' THEN 1 ELSE 0 END) AS available,
       EXISTS (
         SELECT 1
         FROM catalogue_revisions AS revision
         WHERE NOT EXISTS (
             SELECT 1 FROM catalogue_query_revisions AS query
             WHERE query.catalogue_revision_id = revision.id
           )
           AND (? IS NULL OR revision.id = ?)
       ) AS missing
     FROM catalogue_query_revisions
     WHERE (? IS NULL OR catalogue_revision_id = ?)`)
    .bind(targetRevisionId, targetRevisionId, targetRevisionId, targetRevisionId);
}
