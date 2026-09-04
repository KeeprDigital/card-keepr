export function restoreFixturePublicationHealthStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET recovery_health = 'healthy'
         WHERE singleton = 1 AND recovery_health = 'degraded'`);
}

export function fixtureSourceSnapshotStatement(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT * FROM source_snapshots WHERE id = ?");
}

export function cloneFixtureFetchAttemptStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_fetch_attempts (
             id, ingestion_run_id, request_id, attempt_number,
             requested_at, completed_at, outcome, http_status,
             response_headers_json, retry_after_ms, diagnostic
           )
           SELECT ?, ingestion_run_id, request_id, attempt_number + 100,
                  requested_at, completed_at, outcome, http_status,
                  response_headers_json, retry_after_ms, diagnostic
           FROM source_fetch_attempts WHERE id = ?`);
}

export function cloneFixtureSourceSnapshotStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO source_snapshots (
             id, ingestion_run_id, request_id, fetch_attempt_id,
             request_method, request_url, request_headers_json,
             representation_fingerprint, response_vary_json, retrieved_at,
             http_status, response_headers_json, media_type, content_digest,
             content_byte_length, content_object_key, source_lineage,
             supported_game, game_profile_version, adapter_version,
             reused_source_snapshot_id
           )
           SELECT ?, ingestion_run_id, request_id, ?, request_method,
                  request_url, request_headers_json,
                  representation_fingerprint, response_vary_json,
                  retrieved_at, http_status, response_headers_json,
                  media_type, content_digest, content_byte_length,
                  content_object_key, source_lineage, supported_game,
                  game_profile_version, ?, id
           FROM source_snapshots WHERE id = ?`);
}
