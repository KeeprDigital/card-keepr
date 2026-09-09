import { type CatalogueStore, repositoryStatements } from "../shared";
// Prepared statements only; callers own execution and atomic batch composition.

export function hostPacingStatement(database: CatalogueStore, hostname: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT next_request_not_before FROM source_host_pacing WHERE hostname = ?")
    .bind(hostname);
}

export function advanceHostPacingStatement(
  database: CatalogueStore,
  input: Readonly<{ hostname: string; nextRequestAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO source_host_pacing (
        hostname, next_request_not_before, locked_by, lease_expires_at
       ) VALUES (?, ?, NULL, NULL)
       ON CONFLICT(hostname) DO UPDATE SET
         next_request_not_before = excluded.next_request_not_before`)
    .bind(input.hostname, input.nextRequestAt);
}

export function latestCaptureOperationStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; requestId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM source_capture_operations
       WHERE ingestion_run_id = ? AND request_id = ?
         AND state IN ('planned', 'response_received', 'uploaded')
       ORDER BY attempt_number DESC LIMIT 1`)
    .bind(input.runId, input.requestId);
}

export function latestAttemptNumberStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; requestId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number
       FROM source_fetch_attempts
       WHERE ingestion_run_id = ? AND request_id = ?`)
    .bind(input.runId, input.requestId);
}

export function latestTransportAttemptStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; requestId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT outcome, http_status, attempt_number
         FROM source_fetch_attempts
         WHERE ingestion_run_id = ? AND request_id = ?
         ORDER BY attempt_number DESC LIMIT 1`)
    .bind(input.runId, input.requestId);
}

export function createCaptureOperationStatement(
  database: CatalogueStore,
  input: Readonly<{
    attemptId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
    snapshotId: string;
    objectKey: string;
    requestedAt: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO source_capture_operations (
        attempt_id, ingestion_run_id, request_id, attempt_number,
        source_snapshot_id, content_object_key, state, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)`)
    .bind(
      input.attemptId,
      input.runId,
      input.requestId,
      input.attemptNumber,
      input.snapshotId,
      input.objectKey,
      input.requestedAt,
    );
}

export function refreshCaptureRequestedAtStatement(
  database: CatalogueStore,
  input: Readonly<{ requestedAt: string; attemptId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_capture_operations SET requested_at = ?
         WHERE attempt_id = ? AND state = 'planned'`)
    .bind(input.requestedAt, input.attemptId);
}

export function revalidatedCaptureStatement(
  database: CatalogueStore,
  input: Readonly<{
    completedAt: string;
    requestHeadersJson: string;
    status: number;
    responseHeadersJson: string;
    responseVaryJson: string;
    mediaType: string | null;
    digest: string;
    byteLength: number;
    reusedSnapshotId: string;
    attemptId: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_capture_operations
         SET state = 'uploaded', completed_at = ?,
             request_headers_json = ?, http_status = ?,
             response_headers_json = ?, response_vary_json = ?,
             media_type = ?, content_digest = ?,
             content_byte_length = ?, reused_source_snapshot_id = ?
         WHERE attempt_id = ?
           AND state IN ('planned', 'response_received')`)
    .bind(
      input.completedAt,
      input.requestHeadersJson,
      input.status,
      input.responseHeadersJson,
      input.responseVaryJson,
      input.mediaType,
      input.digest,
      input.byteLength,
      input.reusedSnapshotId,
      input.attemptId,
    );
}

export function receivedCaptureResponseStatement(
  database: CatalogueStore,
  input: Readonly<{
    completedAt: string;
    requestHeadersJson: string;
    status: number;
    responseHeadersJson: string;
    responseVaryJson: string;
    mediaType: string | null;
    attemptId: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_capture_operations
       SET state = 'response_received', completed_at = ?,
           request_headers_json = ?, http_status = ?,
           response_headers_json = ?, response_vary_json = ?,
           media_type = ?
       WHERE attempt_id = ? AND state = 'planned'`)
    .bind(
      input.completedAt,
      input.requestHeadersJson,
      input.status,
      input.responseHeadersJson,
      input.responseVaryJson,
      input.mediaType,
      input.attemptId,
    );
}

export function uploadedCaptureContentStatement(
  database: CatalogueStore,
  input: Readonly<{ digest: string; byteLength: number; attemptId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_capture_operations
         SET state = 'uploaded', content_digest = ?,
             content_byte_length = ?
         WHERE attempt_id = ? AND state = 'response_received'`)
    .bind(input.digest, input.byteLength, input.attemptId);
}

export function capturedSnapshotStatement(
  database: CatalogueStore,
  input: Readonly<{
    snapshotId: string;
    runId: string;
    requestId: string;
    attemptId: string;
    requestUrl: string;
    requestHeadersJson: string;
    representationFingerprint: string;
    responseVaryJson: string;
    retrievedAt: string;
    status: number;
    responseHeadersJson: string;
    mediaType: string | null;
    digest: string;
    byteLength: number;
    objectKey: string;
    sourceLineage: string;
    supportedGame: string;
    gameProfileVersion: string;
    adapterVersion: string;
    reusedSnapshotId: string | null;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO source_snapshots (
          id, ingestion_run_id, request_id, fetch_attempt_id,
          request_method, request_url, request_headers_json,
          representation_fingerprint, response_vary_json, retrieved_at,
          http_status, response_headers_json, media_type, content_digest,
          content_byte_length, content_object_key, source_lineage,
          supported_game, game_profile_version, adapter_version,
          reused_source_snapshot_id
        ) VALUES (?, ?, ?, ?, 'GET', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      input.snapshotId,
      input.runId,
      input.requestId,
      input.attemptId,
      input.requestUrl,
      input.requestHeadersJson,
      input.representationFingerprint,
      input.responseVaryJson,
      input.retrievedAt,
      input.status,
      input.responseHeadersJson,
      input.mediaType,
      input.digest,
      input.byteLength,
      input.objectKey,
      input.sourceLineage,
      input.supportedGame,
      input.gameProfileVersion,
      input.adapterVersion,
      input.reusedSnapshotId,
    );
}

export function capturedSourceRequestStatement(
  database: CatalogueStore,
  input: Readonly<{ snapshotId: string; runId: string; requestId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_requests
         SET state = 'captured', source_snapshot_id = ?
         WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`)
    .bind(input.snapshotId, input.runId, input.requestId);
}

export function finalizeCaptureStatement(database: CatalogueStore, attemptId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_capture_operations SET state = 'finalized'
         WHERE attempt_id = ? AND state = 'uploaded'`)
    .bind(attemptId);
}

export function remainingLineageRequestsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; lineagePattern: string; excludedRequestId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT COUNT(*) AS count FROM source_requests
             WHERE ingestion_run_id = ?
               AND request_id LIKE ?
               AND request_id != ?
               AND state IN ('pending', 'captured')`)
    .bind(input.runId, input.lineagePattern, input.excludedRequestId);
}

export function observedSourceRequestStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; requestId: string; snapshotId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_requests SET state = 'observed'
         WHERE ingestion_run_id = ? AND request_id = ?
           AND source_snapshot_id = ? AND state = 'captured'`)
    .bind(input.runId, input.requestId, input.snapshotId);
}

export function sourceRequestStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; requestId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = ?`)
    .bind(input.runId, input.requestId);
}

export function captureOperationStatement(database: CatalogueStore, attemptId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT * FROM source_capture_operations WHERE attempt_id = ?")
    .bind(attemptId);
}

export function failedCaptureTransportStatement(
  database: CatalogueStore,
  input: Readonly<{
    completedAt: string;
    status: number | null;
    responseHeadersJson: string;
    outcome: string;
    diagnostic: string | null;
    attemptId: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_capture_operations
         SET state = 'failed', completed_at = ?, http_status = ?,
             response_headers_json = ?, failure_outcome = ?,
             diagnostic = ?
         WHERE attempt_id = ? AND state <> 'finalized'`)
    .bind(input.completedAt, input.status, input.responseHeadersJson, input.outcome, input.diagnostic, input.attemptId);
}

export function rejectedCaptureStatement(
  database: CatalogueStore,
  input: Readonly<{
    completedAt: string;
    status: number;
    responseHeadersJson: string;
    diagnostic: string;
    attemptId: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_capture_operations
         SET state = 'failed', completed_at = ?, http_status = ?,
             response_headers_json = ?, diagnostic = ?
         WHERE attempt_id = ? AND state <> 'finalized'`)
    .bind(input.completedAt, input.status, input.responseHeadersJson, input.diagnostic, input.attemptId);
}

export function failedSourceRequestStatement(
  database: CatalogueStore,
  input: Readonly<{ failureCode: string; runId: string; requestId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE source_requests
       SET state = 'failed', failure_code = ?
       WHERE ingestion_run_id = ? AND request_id = ?
         AND state IN ('pending', 'captured')`)
    .bind(input.failureCode, input.runId, input.requestId);
}

export function reusableSnapshotsStatement(
  database: CatalogueStore,
  input: Readonly<{
    sourceLineage: string;
    requestUrl: string;
    adapterVersion: string;
    representationFingerprint: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM source_snapshots
       WHERE NOT EXISTS(SELECT 1 FROM evidence_cleanup_objects reclaimed WHERE reclaimed.object_key=source_snapshots.content_object_key)
         AND source_lineage = ? AND request_url = ?
         AND adapter_version = ? AND representation_fingerprint = ?
         AND (
           json_extract(response_headers_json, '$.etag') IS NOT NULL
           OR json_extract(response_headers_json, '$."last-modified"') IS NOT NULL
         )
       ORDER BY retrieved_at DESC, id DESC LIMIT 10`)
    .bind(input.sourceLineage, input.requestUrl, input.adapterVersion, input.representationFingerprint);
}
