const repairableCatalogueRevisionCte = `WITH RECURSIVE repairable_catalogue_revisions(
     revision_id, depth
   ) AS (
     SELECT revision.id, 0
     FROM catalogue_state AS state
     JOIN catalogue_revisions AS revision
       ON revision.id = state.current_revision_id
     WHERE state.singleton = 1
     UNION ALL
     SELECT previous.id,
            repairable_catalogue_revisions.depth + 1
     FROM repairable_catalogue_revisions
     JOIN catalogue_revisions AS revision
       ON revision.id = repairable_catalogue_revisions.revision_id
     JOIN catalogue_revisions AS previous
       ON previous.id = revision.expected_previous_revision_id
     WHERE repairable_catalogue_revisions.depth < 2
   )`;

export function repairableCatalogueRevisionWindow(
  database: D1Database,
): Promise<D1Result<{ revision_id: string; depth: number }>> {
  return database
    .prepare(
      `${repairableCatalogueRevisionCte}
       SELECT revision_id, depth
       FROM repairable_catalogue_revisions
       ORDER BY depth`,
    )
    .all<{ revision_id: string; depth: number }>();
}

export function repairableCatalogueRevisionTarget(
  database: D1Database,
  targetRevisionId: string,
): Promise<{
  current_revision_id: string;
  target_exists: number;
  target_retained: number;
} | null> {
  return database
    .prepare(
      `${repairableCatalogueRevisionCte}
       SELECT state.current_revision_id,
              EXISTS (
                SELECT 1 FROM catalogue_revisions AS revision
                WHERE revision.id = ?
              ) AS target_exists,
              EXISTS (
                SELECT 1 FROM repairable_catalogue_revisions
                WHERE revision_id = ?
              ) AS target_retained
       FROM catalogue_state AS state
       WHERE state.singleton = 1`,
    )
    .bind(targetRevisionId, targetRevisionId)
    .first<{
      current_revision_id: string;
      target_exists: number;
      target_retained: number;
    }>();
}
