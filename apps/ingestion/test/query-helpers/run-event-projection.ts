// Named queries for projection corruption, rollback, and rebuild tests.

export function resetEventFixtureOperation(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `UPDATE operation_state SET active_ingestion_run_id=NULL, active_production_release_id=NULL, active_production_release_expires_at=NULL WHERE singleton=1`,
  );
}

export function reserveEventFixtureRun(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_ingestion_run_id = ? WHERE singleton=1`).bind(runId);
}

export function readEventFixtureCurrent(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`SELECT * FROM ingestion_run_current WHERE ingestion_run_id=?`).bind(runId);
}

export function countRunEvents(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`SELECT count(*) AS count FROM ingestion_run_events WHERE ingestion_run_id=?`).bind(runId);
}

export function attemptEventRewrite(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_run_events SET to_state='failed'`);
}

export function attemptEventDeletion(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM ingestion_run_events`);
}

export function clearEventFixtureReservation(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_ingestion_run_id=NULL WHERE singleton=1`);
}

export function writeEventFixtureSibling(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE catalogue_state SET published_at='sibling' WHERE singleton=1`);
}

export function readEventFixtureSibling(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT published_at FROM catalogue_state WHERE singleton=1`);
}

export function corruptEventFixtureProgress(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_run_current SET completed_stage_count=1 WHERE ingestion_run_id=?`)
    .bind(runId);
}

export function readEventFixtureDocument(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`SELECT * FROM ingestion_run_read WHERE id=?`).bind(runId);
}

export function claimEventFixtureMaintenance(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `UPDATE operation_state SET active_production_release_id='event_rebuild', active_production_release_expires_at='2099-01-01T00:00:00.000Z' WHERE singleton=1`,
  );
}

export function deleteEventFixtureCurrent(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`DELETE FROM ingestion_run_current WHERE ingestion_run_id=?`).bind(runId);
}

export function deleteEventFixtureGames(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`DELETE FROM ingestion_run_selected_games WHERE ingestion_run_id=?`).bind(runId);
}

export function corruptEventFixtureTerminalState(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_run_current SET state='failed' WHERE ingestion_run_id=?`).bind(runId);
}

export function readEventFixtureReservation(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT active_ingestion_run_id FROM operation_state WHERE singleton=1`);
}

export function deleteEventFixtureReservation(database: D1Database, runId: string) {
  return database.prepare("DELETE FROM ingestion_collection_reservations WHERE ingestion_run_id = ?").bind(runId);
}
