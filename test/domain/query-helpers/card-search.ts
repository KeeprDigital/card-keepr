import type { DatabaseSync, StatementSync } from "node:sqlite";

// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function setCardSearchFtsStateStateOwnerToken(database: DatabaseSync): StatementSync {
  return database.prepare(`UPDATE card_search_fts_state
       SET state = 'reconstructing', owner_token = ?, lease_expires_at = ?
       WHERE singleton = 1 AND state = 'ready'`);
}

export function countRevisionCardSearchChunksCount(database: DatabaseSync): StatementSync {
  return database.prepare(`SELECT count(*) AS count FROM revision_card_search_chunks
         WHERE catalogue_revision_id = 'catrev_backup_restore'`);
}

export function setCardSearchFtsStateStateOwnerTokenForD1BackupExportRestoresReconstructibleCardFTSIndex(
  database: DatabaseSync,
): StatementSync {
  return database.prepare(`UPDATE card_search_fts_state
       SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
       WHERE singleton = 1 AND owner_token = ?`);
}

export function readCardSearchFtsStateState(database: DatabaseSync): StatementSync {
  return database.prepare("SELECT state FROM card_search_fts_state WHERE singleton = 1");
}

export function readRevisionCardSearchFtsCatalogueRevisionId(database: DatabaseSync): StatementSync {
  return database.prepare(`SELECT catalogue_revision_id
     FROM revision_card_search_fts
     WHERE revision_card_search_fts MATCH ?`);
}

export function readSqliteSchemaTypeName(database: DatabaseSync): StatementSync {
  return database.prepare(`SELECT type, name, sql
     FROM sqlite_schema
     WHERE name IN (
       'revision_card_search_fts_rows',
       'revision_card_search_fts',
       'revision_card_search_chunks_insert_fts',
       'revision_card_search_chunks_delete_fts',
       'revision_card_search_chunks_before_update_fts',
       'revision_card_search_chunks_after_update_fts'
     )
     ORDER BY type, name`);
}
