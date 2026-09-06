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
      .prepare(`DELETE FROM game_candidate_slots
      WHERE ingestion_run_id IN (${terminal})`)
      .bind(runId ?? null, runId ?? null),
    repositoryStatements(database)
      .prepare(`UPDATE reconciliation_operations SET state = 'failed',
      failure_code = (SELECT failure_code FROM ingestion_run_current WHERE ingestion_run_id = reconciliation_operations.ingestion_run_id)
      WHERE state = 'preparing' AND ingestion_run_id IN (SELECT ingestion_run_id FROM ingestion_run_current
        WHERE state = 'failed' AND (? IS NULL OR ingestion_run_id = ?))`)
      .bind(runId ?? null, runId ?? null),
  ];
}
