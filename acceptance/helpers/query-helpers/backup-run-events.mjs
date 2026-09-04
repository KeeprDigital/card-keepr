export function backupRunIdentity(database) {
  return database.prepare("SELECT * FROM ingestion_runs WHERE id = ?");
}
export function backupRunCurrent(database) {
  return database.prepare("SELECT * FROM ingestion_run_current WHERE ingestion_run_id = ?");
}
export function backupRunGames(database) {
  return database.prepare("SELECT * FROM ingestion_run_selected_games WHERE ingestion_run_id = ? ORDER BY ordinal");
}
export function backupRunEvents(database) {
  return database.prepare("SELECT * FROM ingestion_run_events WHERE ingestion_run_id = ? ORDER BY sequence_number");
}
export function backupRunPayloads(database) {
  return database.prepare(
    "SELECT * FROM ingestion_run_event_payload_chunks WHERE ingestion_run_id = ? ORDER BY event_sequence, payload_kind, chunk_index",
  );
}
export function backupRunDocument(database) {
  return database.prepare("SELECT * FROM ingestion_run_read WHERE id = ?");
}
