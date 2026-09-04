// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function readRevisionCardSearchFts(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT DISTINCT catalogue_revision_id
     FROM revision_card_search_fts
     WHERE revision_card_search_fts MATCH ?
     ORDER BY catalogue_revision_id`);
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
        WHERE catalogue_revision_id = ?) AS indexed_chunks,
       (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger'
         AND name LIKE 'revision_card_search_chunks_%_fts') AS maintenance_triggers`);
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

export function insertRevisionCardSearchChunks(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_card_search_chunks (
           catalogue_revision_id, card_id, field_ordinal,
           chunk_ordinal, search_text
         ) VALUES (?, ?, ?, ?, ?)`);
}

export function measureRevisionCardSearchChunks(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS chunk_count,
    MAX(length(search_text)) AS maximum_chunk_length,
    SUM(length(CAST(search_text AS BLOB))) AS chunk_bytes
    FROM revision_card_search_chunks
    WHERE catalogue_revision_id = ?
      AND card_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`);
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

export function dropObsoleteCardSearchTerms(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TABLE IF EXISTS revision_card_search_terms");
}

export function indexFixtureCardSearchRows(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT OR IGNORE INTO revision_card_search_fts_rows (
    catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
  ) SELECT catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
    FROM revision_card_search_chunks
    WHERE catalogue_revision_id = ? AND card_id = ?`);
}

export function indexFixtureCardSearchContents(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_card_search_fts (
    rowid, revision_token, catalogue_revision_id, card_id,
    field_ordinal, chunk_ordinal, search_text
  ) SELECT indexed.fts_rowid, '|' || chunk.catalogue_revision_id || '|',
      chunk.catalogue_revision_id, chunk.card_id, chunk.field_ordinal,
      chunk.chunk_ordinal, chunk.search_text
    FROM revision_card_search_chunks AS chunk
    JOIN revision_card_search_fts_rows AS indexed
      USING (catalogue_revision_id, card_id, field_ordinal, chunk_ordinal)
    WHERE chunk.catalogue_revision_id = ? AND chunk.card_id = ?
      AND NOT EXISTS (SELECT 1 FROM revision_card_search_fts WHERE rowid = indexed.fts_rowid)`);
}
