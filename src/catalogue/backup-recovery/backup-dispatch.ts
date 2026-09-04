import { canonicalJson, sha256Text } from "../shared";
import {
  backupDispatchStatusStatement,
  backupWorkflowRequestStatement,
  outstandingBackupDispatchesStatement,
  pendingBackupDispatchStatement,
} from "./backup-dispatch-repository";

export const maximumBackupDispatchAttempts = 3;

export async function publicationBackupDispatchStatements(
  database: D1Database,
  revisionId: string,
  key: string,
  at: string,
): Promise<D1PreparedStatement[]> {
  const input = { expected_current_revision_id: revisionId, idempotency_key: key };
  const requestJson = canonicalJson(input);
  return [
    backupWorkflowRequestStatement(database, {
      key,
      revisionId,
      requestJson,
      paramsJson: canonicalJson({ ...input, observed_at: at }),
      workflowId: `backup-${(await sha256Text(requestJson)).slice(0, 64)}`,
      at,
      linkedAttemptId: null,
    }),
    pendingBackupDispatchStatement(database, key, at),
  ];
}

export async function backupDispatchStatus(database: D1Database, key: string): Promise<Record<string, unknown> | null> {
  const row = await backupDispatchStatusStatement(database, key).first<{
    state: string;
    attempt_count: number;
    failure_detail: string | null;
    updated_at: string;
    idempotency_key: string;
    request_json: string;
    workflow_instance_id: string;
  }>();
  if (row === null) return null;
  return {
    state: row.state,
    attempt_count: row.attempt_count,
    updated_at: row.updated_at,
    workflow_instance_id: row.workflow_instance_id,
    failure:
      row.failure_detail === null ? null : { code: "catalogue_backup_dispatch_failed", detail: row.failure_detail },
    retry:
      row.state === "dispatched"
        ? null
        : {
            method: "POST",
            path: "/v1/backups",
            body: JSON.parse(row.request_json),
            maximum_attempts_per_request: maximumBackupDispatchAttempts,
          },
  };
}

export async function outstandingBackupDispatches(database: D1Database): Promise<Record<string, unknown>[]> {
  const rows = await outstandingBackupDispatchesStatement(database).all<{ idempotency_key: string }>();
  const statuses = await Promise.all(
    rows.results.map(async ({ idempotency_key }) => ({
      idempotency_key,
      ...(await backupDispatchStatus(database, idempotency_key)),
    })),
  );
  return statuses;
}
