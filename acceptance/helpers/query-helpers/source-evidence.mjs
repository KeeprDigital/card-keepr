// Named SQLite statements; tests retain bindings, execution, and assertions.

export function runHasSourceRequests(database) {
  return database.prepare("SELECT 1 FROM source_requests WHERE ingestion_run_id = ? LIMIT 1");
}

export function runSourceRequestsDiagnostics(database) {
  return database.prepare(`
          SELECT request_id, request_role, url, request_headers_json, state,
                 failure_code, source_snapshot_id, discovered_from_request_id
          FROM source_requests WHERE ingestion_run_id = ?
          ORDER BY sequence_number
        `);
}

export function runFetchAttemptsDiagnostics(database) {
  return database.prepare(`
          SELECT request_id, attempt_number, outcome, http_status,
                 response_headers_json, diagnostic
          FROM source_fetch_attempts WHERE ingestion_run_id = ?
          ORDER BY request_id, attempt_number
        `);
}

export function runCapturesDiagnostics(database) {
  return database.prepare(`
          SELECT request_id, attempt_number, state, http_status,
                 response_headers_json, media_type, content_digest,
                 content_byte_length, diagnostic
          FROM source_capture_operations WHERE ingestion_run_id = ?
          ORDER BY request_id, attempt_number
        `);
}

export function runSnapshotsDiagnostics(database) {
  return database.prepare(`
          SELECT id, request_id, request_url, request_headers_json, http_status,
                 response_headers_json, media_type, content_digest,
                 content_byte_length
          FROM source_snapshots WHERE ingestion_run_id = ?
          ORDER BY retrieved_at, request_id
        `);
}

export function runParsesDiagnostics(database) {
  return database.prepare(`
          SELECT snapshots.request_id, operations.id, operations.state,
                 operations.adapter_version, operations.observation_count
          FROM source_parse_operations AS operations
          JOIN source_snapshots AS snapshots
            ON snapshots.id = operations.source_snapshot_id
          WHERE snapshots.ingestion_run_id = ?
          ORDER BY snapshots.request_id
        `);
}

export function runDiscoveryChildrenDiagnostics(database) {
  return database.prepare(`
          SELECT request_id, parent_request_id, request_role, url,
                 request_headers_json
          FROM source_discovery_request_plans
          WHERE ingestion_run_id = ?
          ORDER BY sequence_number
        `);
}
