import { type CatalogueStore, repositoryStatements } from "../shared";
export type BackupDispatchRow = {
  state: string;
  attempt_count: number;
  failure_detail: string | null;
  updated_at: string;
  idempotency_key: string;
  request_json: string;
  workflow_instance_id: string;
};

export type OutstandingBackupDispatchRow = Pick<BackupDispatchRow, "idempotency_key">;

export function pendingBackupDispatchStatement(database: CatalogueStore, key: string, at: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO catalogue_backup_dispatch (idempotency_key, state, updated_at)
    SELECT ?1, 'pending', ?2 WHERE EXISTS (SELECT 1 FROM catalogue_backup_workflow_requests WHERE idempotency_key = ?1)`)
    .bind(key, at);
}

export function backupDispatchAttemptStatement(database: CatalogueStore, key: string, at: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_dispatch SET attempt_count = attempt_count + 1, updated_at = ?
    WHERE idempotency_key = ? AND state <> 'dispatched'`)
    .bind(at, key);
}

export function backupDispatchOutcomeStatement(
  database: CatalogueStore,
  key: string,
  detail: string | null,
  at: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE catalogue_backup_dispatch SET state = ?, failure_detail = ?, updated_at = ?
    WHERE idempotency_key = ? AND state <> 'dispatched'`)
    .bind(detail === null ? "dispatched" : "failed", detail, at, key);
}

export function backupDispatchStatusStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT dispatch.state, dispatch.attempt_count, dispatch.failure_detail, dispatch.updated_at,
    request.idempotency_key, request.request_json, request.workflow_instance_id
    FROM catalogue_backup_workflow_requests AS request
    JOIN catalogue_backup_dispatch AS dispatch USING (idempotency_key)
    WHERE request.idempotency_key = ?`)
    .bind(key);
}

export function outstandingBackupDispatchesStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT idempotency_key FROM catalogue_backup_dispatch
    WHERE state IN ('pending', 'failed') ORDER BY updated_at, idempotency_key LIMIT 20`);
}

export function backupWorkflowRequestStatement(
  database: CatalogueStore,
  input: {
    key: string;
    revisionId: string;
    requestJson: string;
    paramsJson: string;
    workflowId: string;
    at: string;
    linkedAttemptId: string | null;
  },
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO catalogue_backup_workflow_requests (
    idempotency_key, expected_current_revision_id, request_json, workflow_params_json, workflow_instance_id, observed_at, linked_attempt_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      input.key,
      input.revisionId,
      input.requestJson,
      input.paramsJson,
      input.workflowId,
      input.at,
      input.linkedAttemptId,
    );
}
