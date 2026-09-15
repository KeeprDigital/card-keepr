export function retainedTcgdexContexts(db: D1Database) {
  return db.prepare(`SELECT snapshot.request_url,context.dependency_count,
    operation.observation_set_id,operation.id AS parse_operation_id,
    operation.state,snapshot.id AS snapshot_id,snapshot.retrieved_at,snapshot.content_digest
    FROM source_parse_contexts context JOIN source_parse_operations operation ON operation.id=context.parse_operation_id
    JOIN source_snapshots snapshot ON snapshot.id=operation.source_snapshot_id
    WHERE snapshot.ingestion_run_id=? ORDER BY context.dependency_count`);
}
