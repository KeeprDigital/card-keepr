export function runAnchorColumns(database) {
  return database.prepare("SELECT name FROM pragma_table_info('ingestion_runs') ORDER BY cid");
}
export function runCurrentColumns(database) {
  return database.prepare("SELECT name FROM pragma_table_info('ingestion_run_current') ORDER BY cid");
}
export function runAnchorPage(database) {
  return database.prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'ingestion_runs'");
}
export function runForeignKeys(database) {
  return database.prepare(`SELECT schema.name AS child, fk.id, fk.seq, fk.[from], fk.[to], fk.on_delete
    FROM sqlite_schema AS schema, pragma_foreign_key_list(schema.name) AS fk
    WHERE schema.type = 'table' AND fk.[table] = 'ingestion_runs'
    ORDER BY schema.name, fk.id, fk.seq`);
}
export function runEventRows(database) {
  return database.prepare("SELECT * FROM ingestion_run_events ORDER BY ingestion_run_id, sequence_number");
}
export function runProjectionRows(database) {
  return database.prepare("SELECT * FROM ingestion_run_current ORDER BY ingestion_run_id");
}
export function retainedRunPins(database) {
  return database.prepare("SELECT * FROM ingestion_run_curated_revision_sets ORDER BY ingestion_run_id");
}
export function approvalIdentity(database) {
  return database.prepare("SELECT approval_idempotency_key FROM ingestion_runs WHERE id = 'run_schema'");
}
export function eventPayloadRows(database) {
  return database.prepare("SELECT * FROM ingestion_run_event_payload_chunks ORDER BY chunk_index");
}
export function insertPayloadChunk(database) {
  return database.prepare("INSERT INTO ingestion_run_event_payload_chunks VALUES ('run_schema', 1, 'candidate', ?, ?)");
}

export function renderedRun(database) {
  return database.prepare("SELECT * FROM ingestion_run_read WHERE id = 'run_schema'");
}
