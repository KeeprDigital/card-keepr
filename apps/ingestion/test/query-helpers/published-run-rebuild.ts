// Named inspection and deliberate projection damage for the published rebuild contract.
export function readPublishedRunHistory(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT * FROM ingestion_run_events WHERE ingestion_run_id = ? ORDER BY sequence_number`)
    .bind(runId);
}

export function readPublishedRunPayloads(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT * FROM ingestion_run_event_payload_chunks WHERE ingestion_run_id = ?
    ORDER BY event_sequence, payload_kind, chunk_index`)
    .bind(runId);
}

export function readPublishedRunProjection(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`SELECT * FROM ingestion_run_read WHERE id = ?`).bind(runId);
}

export function claimPublishedRunRebuild(
  database: D1Database,
  ownerId: string,
  expiresAt: string,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE operation_state SET active_production_release_id = ?, active_production_release_expires_at = ?
    WHERE singleton = 1 AND active_ingestion_run_id IS NULL AND active_production_release_id IS NULL
      AND recovery_health = 'healthy' AND recovery_restore_guard = 'clear' AND active_recovery_id IS NULL`)
    .bind(ownerId, expiresAt);
}

export function releasePublishedRunRebuild(
  database: D1Database,
  ownerId: string,
  expiresAt: string,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE operation_state SET active_production_release_id = NULL, active_production_release_expires_at = NULL
    WHERE singleton = 1 AND active_production_release_id = ? AND active_production_release_expires_at = ?`)
    .bind(ownerId, expiresAt);
}

export function deletePublishedRunProjection(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`DELETE FROM ingestion_run_current WHERE ingestion_run_id = ?`).bind(runId);
}

export function deletePublishedRunGames(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`DELETE FROM ingestion_run_selected_games WHERE ingestion_run_id = ?`).bind(runId);
}

export function readPublishedRunCurrent(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`SELECT * FROM ingestion_run_current WHERE ingestion_run_id = ?`).bind(runId);
}
