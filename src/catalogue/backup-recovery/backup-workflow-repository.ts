export function backupWorkflowStartStateStatement(
  database: D1Database,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return database
    .prepare(`SELECT catalogue.current_revision_id,
              operation.active_ingestion_run_id,
              operation.recovery_health,
              EXISTS (
                SELECT 1 FROM catalogue_backup_attempts
                WHERE idempotency_key = ?
                  AND publication_ingestion_run_id IS NOT NULL
              ) AS publication_attempt
       FROM catalogue_state AS catalogue
       JOIN operation_state AS operation ON operation.singleton = 1
       WHERE catalogue.singleton = 1`)
    .bind(input.idempotency_key);
}

export function insertBackupWorkflowRequestStatement(
  database: D1Database,
  input: Readonly<{
    idempotency_key: string;
    expected_current_revision_id: string;
    requestJson: string;
    paramsJson: string;
    workflowInstanceId: string;
    observedAt: string;
    linkedAttemptId: string | null;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT OR IGNORE INTO catalogue_backup_workflow_requests (
         idempotency_key, expected_current_revision_id, request_json,
         workflow_params_json, workflow_instance_id, observed_at,
         linked_attempt_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      input.idempotency_key,
      input.expected_current_revision_id,
      input.requestJson,
      input.paramsJson,
      input.workflowInstanceId,
      input.observedAt,
      input.linkedAttemptId,
    );
}

export function linkedBackupWorkflowRequestStatement(
  database: D1Database,
  input: Readonly<{ linkedAttemptId: string }>,
): D1PreparedStatement {
  return database
    .prepare(`SELECT idempotency_key FROM catalogue_backup_workflow_requests
         WHERE linked_attempt_id = ? LIMIT 1`)
    .bind(input.linkedAttemptId);
}

export function retainedBackupOutcomeStatement(
  database: D1Database,
  input: Readonly<{ idempotency_key: string }>,
): D1PreparedStatement {
  return database
    .prepare(`SELECT attempt.state, attempt.catalogue_revision_id, attempt.object_key,
            attempt.d1_bookmark, attempt.failure_code, attempt.failure_detail,
            attempt.content_sha256, attempt.manifest_key,
            attempt.manifest_sha256, attempt.linked_attempt_id,
            retention.newest_success, retention.retain_until
     FROM catalogue_backup_attempts AS attempt
     LEFT JOIN catalogue_backup_retention AS retention
       ON retention.attempt_id = attempt.idempotency_key
     WHERE attempt.idempotency_key = ?`)
    .bind(input.idempotency_key);
}

export function backupWorkflowRequestStatement(
  database: D1Database,
  input: Readonly<{ idempotencyKey: string }>,
): D1PreparedStatement {
  return database
    .prepare(`SELECT idempotency_key, expected_current_revision_id, request_json,
            workflow_params_json, workflow_instance_id, observed_at,
            linked_attempt_id
     FROM catalogue_backup_workflow_requests WHERE idempotency_key = ?`)
    .bind(input.idempotencyKey);
}
