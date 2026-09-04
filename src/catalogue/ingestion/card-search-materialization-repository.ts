import { type CatalogueStore, repositoryStatements } from "../shared";

/** Select persisted chunks by their closed logical keys; rowids never depend on intervening writes. */
export function materializeCardSearchChunkStatements(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; chunksJson: string }>,
): D1PreparedStatement[] {
  return [
    repositoryStatements(database)
      .prepare(`INSERT OR IGNORE INTO revision_card_search_fts_rows (
      catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
    ) SELECT chunk.catalogue_revision_id, chunk.card_id, chunk.field_ordinal, chunk.chunk_ordinal
      FROM revision_card_search_chunks AS chunk
      JOIN json_each(?) AS requested
        ON chunk.card_id = json_extract(requested.value, '$.card_id')
        AND chunk.field_ordinal = json_extract(requested.value, '$.field_ordinal')
        AND chunk.chunk_ordinal = json_extract(requested.value, '$.chunk_ordinal')
      WHERE chunk.catalogue_revision_id = ?`)
      .bind(input.chunksJson, input.revisionId),
    repositoryStatements(database)
      .prepare(`INSERT OR REPLACE INTO revision_card_search_fts (
      rowid, revision_token, catalogue_revision_id, card_id, field_ordinal, chunk_ordinal, search_text
    ) SELECT indexed.fts_rowid, '|' || chunk.catalogue_revision_id || '|', chunk.catalogue_revision_id,
        chunk.card_id, chunk.field_ordinal, chunk.chunk_ordinal, chunk.search_text
      FROM revision_card_search_chunks AS chunk
      JOIN revision_card_search_fts_rows AS indexed USING (catalogue_revision_id, card_id, field_ordinal, chunk_ordinal)
      JOIN json_each(?) AS requested
        ON chunk.card_id = json_extract(requested.value, '$.card_id')
        AND chunk.field_ordinal = json_extract(requested.value, '$.field_ordinal')
        AND chunk.chunk_ordinal = json_extract(requested.value, '$.chunk_ordinal')
      WHERE chunk.catalogue_revision_id = ?`)
      .bind(input.chunksJson, input.revisionId),
  ];
}

/** Remove the FTS contents before deleting logical mappings or cascading chunk rows. */
export function removeArchivedCardSearchStatements(database: CatalogueStore): D1PreparedStatement[] {
  return [
    repositoryStatements(database).prepare(`DELETE FROM revision_card_search_fts WHERE rowid IN (
      SELECT indexed.fts_rowid FROM revision_card_search_fts_rows AS indexed
      JOIN catalogue_query_revisions AS revision USING (catalogue_revision_id)
      WHERE revision.state = 'archived'
    )`),
    repositoryStatements(database).prepare(`DELETE FROM revision_card_search_fts_rows
      WHERE catalogue_revision_id IN (SELECT catalogue_revision_id FROM catalogue_query_revisions WHERE state = 'archived')`),
  ];
}

export function archiveEmptyCardQueryRevisionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`UPDATE catalogue_query_revisions SET state = 'archived',
    repaired_through_card_id = NULL, repair_card_id = NULL, repair_search_offset = 0, repair_chunk_offset = 0
    WHERE state = 'archived' AND NOT EXISTS (
      SELECT 1 FROM revision_card_query_documents AS document
      WHERE document.catalogue_revision_id = catalogue_query_revisions.catalogue_revision_id
    )`);
}
