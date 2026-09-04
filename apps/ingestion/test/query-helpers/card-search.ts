// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function countRevisionCardSearchTermsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(DISTINCT card_id) AS count
     FROM revision_card_search_terms
     WHERE catalogue_revision_id = ? AND term = ?`);
}

export function readRevisionCardSearchFts(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT DISTINCT catalogue_revision_id
     FROM revision_card_search_fts
     WHERE revision_card_search_fts MATCH ?
     ORDER BY catalogue_revision_id`);
}

export function countRevisionCardSearchTermsCountForCardSearchUsesRevisionScopedD1FTS5Index(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT count(*) AS count
     FROM revision_card_search_terms
     WHERE catalogue_revision_id = ? AND term LIKE 'g3:%'`);
}

export function deleteRevisionCardSearchTerms(database: D1Database): D1PreparedStatement {
  return database.prepare("DELETE FROM revision_card_search_terms WHERE catalogue_revision_id = ?");
}

export function readRevisionCardSearchChunksCatalogueRevisionIdCardId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT catalogue_revision_id, card_id, field_ordinal,
            chunk_ordinal, search_text
     FROM revision_card_search_chunks
     WHERE catalogue_revision_id = ?
     ORDER BY card_id, field_ordinal, chunk_ordinal`);
}

export function readCardSearchFtsState(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT
           (SELECT state FROM card_search_fts_state WHERE singleton = 1)
             AS state,
           (SELECT count(*) FROM sqlite_schema
            WHERE type = 'table'
              AND name LIKE 'revision_card%'
              AND lower(sql) LIKE '%create virtual table%')
             AS virtual_tables,
           (SELECT count(*) FROM revision_card_search_chunks
            WHERE catalogue_revision_id = ?) AS retained_chunks`);
}

export function readCardSearchFtsStateForCardSearchFTSReconstructibleAcrossD1ExportRestoreBoundary(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT
       (SELECT state FROM card_search_fts_state WHERE singleton = 1) AS state,
       (SELECT count(*) FROM revision_card_search_fts_rows
        WHERE catalogue_revision_id = ?) AS indexed_chunks`);
}

export function setRevisionCardSearchChunksSearchText(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE revision_card_search_chunks
     SET search_text = 'trigger-rebuilt-quartz'
     WHERE catalogue_revision_id = ? AND card_id = ? AND field_ordinal = 1`);
}

export function readCardSearchFtsStateState(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT state FROM card_search_fts_state WHERE singleton = 1");
}

export function setCardSearchFtsStateStateOwnerToken(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE card_search_fts_state
     SET state = 'reconstructing', owner_token = ?, lease_expires_at = ?
     WHERE singleton = 1 AND state = 'ready'`);
}

export function readCardSearchFtsStateStateOwnerToken(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT state, owner_token FROM card_search_fts_state WHERE singleton = 1");
}

export function insertRevisionCardSearchTerms(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_card_search_terms (
           catalogue_revision_id, card_id, term, sort_game,
           sort_identity_kind, sort_identity_value, sort_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
}

export function insertRevisionCardSearchChunks(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_card_search_chunks (
           catalogue_revision_id, card_id, field_ordinal,
           chunk_ordinal, search_text
         ) VALUES (?, ?, ?, ?, ?)`);
}

export function countRevisionCardSearchTerms(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT
       (SELECT COUNT(*) FROM revision_card_search_terms
        WHERE catalogue_revision_id = ?
          AND card_id IN (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          )) AS term_count,
       (SELECT MAX(length(term)) FROM revision_card_search_terms
        WHERE catalogue_revision_id = ?) AS maximum_term_length,
       (SELECT SUM(length(CAST(search_text AS BLOB)))
        FROM revision_card_search_chunks
        WHERE catalogue_revision_id = ?) AS chunk_bytes`);
}

export function insertRevisionCardSearchChunksForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_card_search_chunks
       (catalogue_revision_id,card_id,field_ordinal,chunk_ordinal,search_text)
       VALUES (?,?,?,?,?)`);
}

export function readRevisionCardSearchFtsCardId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT card_id FROM revision_card_search_fts
     WHERE revision_card_search_fts MATCH ?
       AND catalogue_revision_id=? AND instr(search_text,?)>0`);
}

export function readCardSearchFtsStateStateOwnerTokenForProductionBackupBoundaryExportsVerifiesExactRestoredRevision(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT state, owner_token, lease_expires_at
     FROM card_search_fts_state WHERE singleton = 1`);
}
