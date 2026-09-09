export const prepareCardSearchForD1ExportStatements = Object.freeze([
  "DROP TRIGGER IF EXISTS revision_card_search_chunks_insert_fts",
  "DROP TRIGGER IF EXISTS revision_card_search_chunks_delete_fts",
  "DROP TRIGGER IF EXISTS revision_card_search_chunks_before_update_fts",
  "DROP TRIGGER IF EXISTS revision_card_search_chunks_after_update_fts",
  "DROP TABLE IF EXISTS revision_card_search_fts",
  "DROP TABLE IF EXISTS revision_card_search_fts_rows",
  "DROP TABLE IF EXISTS publication_search_fts",
  "DROP TABLE IF EXISTS revision_products_fts",
]);

export const reconstructCardSearchAfterD1RestoreStatements = Object.freeze([
  `CREATE VIRTUAL TABLE revision_products_fts USING fts5(catalogue_revision_id UNINDEXED, product_id UNINDEXED, search_text, tokenize='unicode61 remove_diacritics 2')`,
  `INSERT INTO revision_products_fts(catalogue_revision_id,product_id,search_text) SELECT catalogue_revision_id,product_id,search_text FROM revision_products`,
  `CREATE VIRTUAL TABLE publication_search_fts USING fts5(candidate_token, candidate_id UNINDEXED, card_id UNINDEXED, search_text, tokenize='trigram case_sensitive 1')`,
  `INSERT INTO publication_search_fts(candidate_token,candidate_id,card_id,search_text)
    SELECT '|' || candidate_id || '|',candidate_id,card_id,search_text FROM publication_search_chunks`,
  `CREATE TABLE revision_card_search_fts_rows (
     fts_rowid INTEGER PRIMARY KEY,
     catalogue_revision_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     field_ordinal INTEGER NOT NULL,
     chunk_ordinal INTEGER NOT NULL,
     UNIQUE (
       catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
     )
   )`,
  `INSERT INTO revision_card_search_fts_rows (
     catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
   )
   SELECT catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
   FROM revision_card_search_chunks`,
  `CREATE VIRTUAL TABLE revision_card_search_fts USING fts5(
     revision_token,
     catalogue_revision_id UNINDEXED,
     card_id UNINDEXED,
     field_ordinal UNINDEXED,
     chunk_ordinal UNINDEXED,
     search_text,
     tokenize = 'trigram case_sensitive 1'
   )`,
  `INSERT INTO revision_card_search_fts (
     rowid, revision_token, catalogue_revision_id, card_id,
     field_ordinal, chunk_ordinal, search_text
   )
   SELECT indexed.fts_rowid,
          '|' || chunk.catalogue_revision_id || '|',
          chunk.catalogue_revision_id, chunk.card_id,
          chunk.field_ordinal, chunk.chunk_ordinal, chunk.search_text
   FROM revision_card_search_chunks AS chunk
   JOIN revision_card_search_fts_rows AS indexed
     USING (
       catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
     )`,
]);
