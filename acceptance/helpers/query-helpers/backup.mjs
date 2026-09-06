// Named SQLite statements; tests retain bindings, execution, and assertions.

export function reserveSearchReconstruction(database) {
  return database.prepare(`UPDATE card_search_fts_state
     SET state = 'reconstructing', owner_token = ?, lease_expires_at = ?
     WHERE singleton = 1`);
}

export function completeSearchReconstruction(database) {
  return database.prepare(`UPDATE card_search_fts_state
     SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
     WHERE singleton = 1`);
}

export function deleteCardSearchFts(database) {
  return database.prepare("DELETE FROM revision_card_search_fts WHERE card_id = ?");
}

export function reinsertCardSearchFts(database) {
  return database.prepare(`INSERT INTO revision_card_search_fts (
       rowid, revision_token, catalogue_revision_id, card_id,
       field_ordinal, chunk_ordinal, search_text
     ) SELECT indexed.fts_rowid, '|' || chunk.catalogue_revision_id || '|',
              chunk.catalogue_revision_id, chunk.card_id,
              chunk.field_ordinal, chunk.chunk_ordinal, chunk.search_text
       FROM revision_card_search_chunks AS chunk
       JOIN revision_card_search_fts_rows AS indexed USING (
         catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
       ) WHERE chunk.card_id = ?`);
}

export function corruptCardApiIdentity(database) {
  return database.prepare(`UPDATE revision_card_query_documents
     SET summary_json = json_set(summary_json, '$.id', 'corrupt_api_id')
     WHERE catalogue_revision_id = ? AND card_id = ?`);
}

export function corruptProductName(database) {
  return database.prepare(`UPDATE revision_products
     SET document_json = json_set(document_json, '$.name', 'Corrupted Product')
     WHERE catalogue_revision_id = ? AND product_id = ?`);
}

export function corruptProductReleases(database) {
  return database.prepare(`UPDATE revision_products
     SET document_json = json_set(document_json, '$.releases', 'malformed')
     WHERE catalogue_revision_id = ? AND product_id = ?`);
}

export function insertRevisionCard(database) {
  return database.prepare(`INSERT INTO revision_cards (
         catalogue_revision_id, card_id, document_json
       ) VALUES (?, ?, ?)`);
}

export function insertCardQueryDocument(database) {
  return database.prepare(`INSERT INTO revision_card_query_documents (
         catalogue_revision_id, card_id, summary_json, search_text
       ) VALUES (?, ?, ?, ?)`);
}

export function insertCardSearchChunk(database) {
  return database.prepare(`INSERT INTO revision_card_search_chunks (
         catalogue_revision_id, card_id, field_ordinal, chunk_ordinal,
         search_text
       ) VALUES (?, ?, 0, 0, ?)`);
}
