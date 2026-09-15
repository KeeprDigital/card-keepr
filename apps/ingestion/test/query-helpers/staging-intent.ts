/** One acknowledged protocol row captured from the former HTTP boundary. */
export function retainedStagingIntentStatement(
  database: D1Database,
  row: { key: string; requestJson: string; responseJson: string; createdAt: string },
) {
  return database
    .prepare(
      `INSERT INTO administration_idempotency
      (idempotency_key, operation, request_json, response_json, http_status, outcome, created_at)
      VALUES (?, 'prepare_staging_release', ?, ?, 201, 'success', ?)`,
    )
    .bind(row.key, row.requestJson, row.responseJson, row.createdAt);
}
