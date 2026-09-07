import { type CatalogueStore, repositoryStatements } from "../shared";

export function preparedCuratedConflictStatement(database: CatalogueStore, preparationId: string, revisionId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT revision_id, content, sha256 FROM reconciliation_curated_conflicts
    WHERE preparation_id = ? AND revision_id = ?`)
    .bind(preparationId, revisionId);
}
export function nextPreparedCuratedConflictStatement(database: CatalogueStore, preparationId: string, afterId: string) {
  return repositoryStatements(database)
    .prepare(`SELECT revision_id, content, sha256 FROM reconciliation_curated_conflicts
    WHERE preparation_id = ? AND revision_id > ? ORDER BY revision_id LIMIT 1`)
    .bind(preparationId, afterId);
}
export function retainCuratedConflictStatement(
  database: CatalogueStore,
  preparationId: string,
  revisionId: string,
  content: string,
  digest: string,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_curated_conflicts
    (preparation_id, revision_id, content, sha256) VALUES (?, ?, ?, ?)
    ON CONFLICT (preparation_id, revision_id) DO NOTHING`)
    .bind(preparationId, revisionId, content, digest);
}
/** Materialize one already visible lifecycle event before an owner mutates that revision. */
export function materializeCuratedConflictStatements(
  database: CatalogueStore,
  revisionId: string,
): D1PreparedStatement[] {
  return [
    repositoryStatements(database)
      .prepare(`INSERT INTO curated_revision_events
      (revision_id, event_version, kind, event_json, created_at, author)
      SELECT revision_id, event_version, 'source_change_detected', json_extract(content, '$.details'),
        json_extract(content, '$.createdAt'), 'system' FROM visible_prepared_curated_conflicts
      WHERE revision_id = ? AND NOT EXISTS (SELECT 1 FROM curated_revision_events AS event
        WHERE event.revision_id = visible_prepared_curated_conflicts.revision_id
          AND event.event_version = visible_prepared_curated_conflicts.event_version)`)
      .bind(revisionId),
    repositoryStatements(database)
      .prepare(`UPDATE curated_revisions SET status = 'reconfirmation_required', event_version = event_version + 1
      WHERE id = ? AND EXISTS (SELECT 1 FROM visible_prepared_curated_conflicts WHERE revision_id = curated_revisions.id)`)
      .bind(revisionId),
  ];
}
