export function measureEventPayload(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT payload_kind, count(*) AS chunks,
    min(chunk_index) AS first_chunk, max(chunk_index) AS last_chunk,
    sum(length(CAST(content AS BLOB))) AS bytes,
    max(length(CAST(content AS BLOB))) AS maximum_bytes
    FROM ingestion_run_event_payload_chunks WHERE ingestion_run_id=?
    GROUP BY payload_kind ORDER BY payload_kind`)
    .bind(runId);
}
export function readEventPayloadMetadata(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT json_extract(payload_json,'$.payloads') AS payloads
    FROM ingestion_run_events WHERE ingestion_run_id=? AND sequence_number=1`)
    .bind(runId);
}
export function countEventAggregate(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT
    (SELECT count(*) FROM ingestion_runs WHERE id=?) AS anchors,
    (SELECT count(*) FROM ingestion_run_current WHERE ingestion_run_id=?) AS projections,
    (SELECT count(*) FROM ingestion_run_events WHERE ingestion_run_id=?) AS events,
    (SELECT count(*) FROM ingestion_run_event_payload_chunks WHERE ingestion_run_id=?) AS chunks`)
    .bind(runId, runId, runId, runId);
}
export function rejectAfterEventPayload(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT json_extract('{}','event_payload_rollback')");
}
export function readEventBoundsSchemaLevel(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton=1");
}
