import { type CatalogueStore, repositoryStatements } from "./catalogue-store-repository";

/** Conservative summary for release/recovery gates while collections overlap. */
export const nextLiveIngestionReservationSql = `(SELECT reservation.ingestion_run_id
  FROM ingestion_collection_reservations AS reservation
  JOIN ingestion_run_current AS run ON run.ingestion_run_id = reservation.ingestion_run_id
  WHERE run.state IN ('collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing')
  ORDER BY reservation.ingestion_run_id LIMIT 1)`;

export function reserveIngestionCollectionStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_collection_reservations (ingestion_run_id)
    VALUES (?)`)
    .bind(runId);
}

/** Terminal lifecycle effects accompany the immutable event in the same transaction. */
export function terminalIngestionReservationEffects(database: CatalogueStore, runId?: string): D1PreparedStatement[] {
  const terminal = `SELECT ingestion_run_id FROM ingestion_run_current
    WHERE state IN ('failed', 'rejected', 'expired', 'published') AND (? IS NULL OR ingestion_run_id = ?)`;
  return [
    repositoryStatements(database)
      .prepare(`UPDATE game_candidates SET state = (
      SELECT state FROM ingestion_run_current WHERE ingestion_run_id = game_candidates.ingestion_run_id
    ) WHERE state <> 'abandoned' AND preparation_id IN (SELECT id FROM reconciliation_operations WHERE supported_game IS NULL) AND ingestion_run_id IN (${terminal})`)
      .bind(runId ?? null, runId ?? null),
    repositoryStatements(database)
      .prepare(`DELETE FROM game_candidate_slots
      WHERE preparation_id IN (SELECT id FROM reconciliation_operations WHERE supported_game IS NULL) AND ingestion_run_id IN (${terminal})`)
      .bind(runId ?? null, runId ?? null),
    repositoryStatements(database)
      .prepare(`UPDATE reconciliation_operations SET state = 'failed',
      failure_code = (SELECT failure_code FROM ingestion_run_current WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id)
      WHERE supported_game IS NULL AND state = 'preparing' AND ingestion_run_id IN (SELECT ingestion_run_id FROM ingestion_run_current
        WHERE state = 'failed' AND (? IS NULL OR ingestion_run_id = ?))`)
      .bind(runId ?? null, runId ?? null),
  ];
}

/** Publication advances only the games represented by the current revision. */
export function projectPublishedGameHeadsStatement(database: CatalogueStore, runId?: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE game_catalogue_heads SET revision_id = (SELECT current_revision_id FROM catalogue_state WHERE singleton = 1)
      WHERE revision_id <> (SELECT current_revision_id FROM catalogue_state WHERE singleton = 1)
        AND supported_game IN (SELECT selected.game FROM catalogue_state AS state
          JOIN catalogue_revisions AS revision ON revision.id = state.current_revision_id
          JOIN ingestion_run_current AS run ON run.ingestion_run_id = revision.ingestion_run_id AND run.state = 'published'
          JOIN ingestion_run_selected_games AS selected ON selected.ingestion_run_id = run.ingestion_run_id
          WHERE state.singleton = 1 AND (? IS NULL OR run.ingestion_run_id = ?))`)
    .bind(runId ?? null, runId ?? null);
}
