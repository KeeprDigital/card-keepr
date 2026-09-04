export function collectionRevisionStatement(
  database: D1Database,
  cursorRevision: string | null,
  options: { search?: boolean; projection?: boolean },
): D1PreparedStatement {
  return database
    .prepare(`
    SELECT revision.id, revision.published_at
    FROM catalogue_revisions AS revision
    ${
      options.projection === false
        ? ""
        : `JOIN catalogue_query_revisions AS projection
      ON projection.catalogue_revision_id = revision.id AND projection.state = 'available'`
    }
    ${options.search === true ? "JOIN card_search_fts_state AS search ON search.singleton = 1 AND search.state = 'ready'" : ""}
    WHERE revision.id = coalesce(?, (SELECT current_revision_id FROM catalogue_state WHERE singleton = 1))
  `)
    .bind(cursorRevision);
}
