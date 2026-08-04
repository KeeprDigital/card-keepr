export const prepareCardSearchForD1ExportStatements = Object.freeze([
  "DROP TRIGGER IF EXISTS revision_card_search_chunks_insert_fts",
  "DROP TRIGGER IF EXISTS revision_card_search_chunks_delete_fts",
  "DROP TRIGGER IF EXISTS revision_card_search_chunks_before_update_fts",
  "DROP TRIGGER IF EXISTS revision_card_search_chunks_after_update_fts",
  "DROP TABLE IF EXISTS revision_card_search_fts",
  "DROP TABLE IF EXISTS revision_card_search_fts_rows",
]);

export const reconstructCardSearchAfterD1RestoreStatements = Object.freeze([
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
  `CREATE TRIGGER revision_card_search_chunks_insert_fts
   AFTER INSERT ON revision_card_search_chunks
   BEGIN
     INSERT INTO revision_card_search_fts_rows (
       catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
     ) VALUES (
       NEW.catalogue_revision_id, NEW.card_id, NEW.field_ordinal,
       NEW.chunk_ordinal
     );
     INSERT INTO revision_card_search_fts (
       rowid, revision_token, catalogue_revision_id, card_id,
       field_ordinal, chunk_ordinal, search_text
     ) VALUES (
       last_insert_rowid(), '|' || NEW.catalogue_revision_id || '|',
       NEW.catalogue_revision_id, NEW.card_id, NEW.field_ordinal,
       NEW.chunk_ordinal, NEW.search_text
     );
   END`,
  `CREATE TRIGGER revision_card_search_chunks_delete_fts
   BEFORE DELETE ON revision_card_search_chunks
   BEGIN
     DELETE FROM revision_card_search_fts
     WHERE rowid = (
       SELECT fts_rowid
       FROM revision_card_search_fts_rows
       WHERE catalogue_revision_id = OLD.catalogue_revision_id
         AND card_id = OLD.card_id
         AND field_ordinal = OLD.field_ordinal
         AND chunk_ordinal = OLD.chunk_ordinal
     );
     DELETE FROM revision_card_search_fts_rows
     WHERE catalogue_revision_id = OLD.catalogue_revision_id
       AND card_id = OLD.card_id
       AND field_ordinal = OLD.field_ordinal
       AND chunk_ordinal = OLD.chunk_ordinal;
   END`,
  `CREATE TRIGGER revision_card_search_chunks_before_update_fts
   BEFORE UPDATE ON revision_card_search_chunks
   BEGIN
     DELETE FROM revision_card_search_fts
     WHERE rowid = (
       SELECT fts_rowid
       FROM revision_card_search_fts_rows
       WHERE catalogue_revision_id = OLD.catalogue_revision_id
         AND card_id = OLD.card_id
         AND field_ordinal = OLD.field_ordinal
         AND chunk_ordinal = OLD.chunk_ordinal
     );
     DELETE FROM revision_card_search_fts_rows
     WHERE catalogue_revision_id = OLD.catalogue_revision_id
       AND card_id = OLD.card_id
       AND field_ordinal = OLD.field_ordinal
       AND chunk_ordinal = OLD.chunk_ordinal;
   END`,
  `CREATE TRIGGER revision_card_search_chunks_after_update_fts
   AFTER UPDATE ON revision_card_search_chunks
   BEGIN
     INSERT INTO revision_card_search_fts_rows (
       catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
     ) VALUES (
       NEW.catalogue_revision_id, NEW.card_id, NEW.field_ordinal,
       NEW.chunk_ordinal
     );
     INSERT INTO revision_card_search_fts (
       rowid, revision_token, catalogue_revision_id, card_id,
       field_ordinal, chunk_ordinal, search_text
     ) VALUES (
       last_insert_rowid(), '|' || NEW.catalogue_revision_id || '|',
       NEW.catalogue_revision_id, NEW.card_id, NEW.field_ordinal,
       NEW.chunk_ordinal, NEW.search_text
     );
   END`,
]);
