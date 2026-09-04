export function reserveEventRun(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare("UPDATE operation_state SET active_ingestion_run_id = ? WHERE singleton = 1").bind(runId);
}
export function readEventRun(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare("SELECT * FROM ingestion_run_read WHERE id = ?").bind(runId);
}
export function readRunEvents(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare("SELECT * FROM ingestion_run_events WHERE ingestion_run_id = ? ORDER BY sequence_number")
    .bind(runId);
}
export function readRunEventPayloadCount(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare("SELECT count(*) AS count FROM ingestion_run_event_payload_chunks WHERE ingestion_run_id = ?")
    .bind(runId);
}

export function corruptPublishedRunProjection(
  database: D1Database,
  runId: string,
  kind: "scalar" | "sequence" | "selected-games" | "missing-current",
): D1PreparedStatement {
  if (kind === "scalar")
    return database
      .prepare("UPDATE ingestion_run_current SET failure_code = 'unexpected' WHERE ingestion_run_id = ?")
      .bind(runId);
  if (kind === "sequence")
    return database
      .prepare(
        "UPDATE ingestion_run_current SET last_event_sequence = last_event_sequence + 1 WHERE ingestion_run_id = ?",
      )
      .bind(runId);
  if (kind === "selected-games")
    return database
      .prepare(
        "UPDATE ingestion_run_selected_games SET game = 'fusion-world' WHERE ingestion_run_id = ? AND ordinal = 0",
      )
      .bind(runId);
  return database.prepare("DELETE FROM ingestion_run_current WHERE ingestion_run_id = ?").bind(runId);
}
export async function removeRetainedRunDiagnostics(database: D1Database, runId: string): Promise<void> {
  // Simulate an incomplete restored database; normal runtime cannot erase these facts.
  await database.exec("DROP TRIGGER ingestion_run_event_payload_chunks_are_immutable_on_delete");
  await database
    .prepare(
      "DELETE FROM ingestion_run_event_payload_chunks WHERE ingestion_run_id = ? AND payload_kind = 'diagnostics'",
    )
    .bind(runId)
    .run();
}
