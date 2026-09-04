export type BackupAttemptEvidenceRow = Readonly<{
  idempotency_key: string;
  request_json: string;
  catalogue_revision_id: string;
  state: string;
  object_key: string;
  d1_bookmark: string | null;
  content_sha256: string | null;
  export_bytes: number | null;
  failure_code: string | null;
  failure_detail: string | null;
  started_at: string;
  completed_at: string | null;
  linked_attempt_id: string | null;
  manifest_sha256: string | null;
  disposable_database_id: string | null;
  restore_generation: number;
  restore_phase: string | null;
}>;

export function backupAttemptEvidenceStatement(database: D1Database, idempotencyKey: string): D1PreparedStatement {
  return database
    .prepare(
      `SELECT idempotency_key, request_json, catalogue_revision_id, state,
            object_key, d1_bookmark, content_sha256, export_bytes,
            failure_code, failure_detail, started_at, completed_at,
            linked_attempt_id, manifest_sha256, disposable_database_id,
            restore_generation, restore_phase
     FROM catalogue_backup_attempts WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey);
}

export type RestorePhaseTransitionInput = {
  idempotencyKey: string;
  ownerToken: string;
  from: string;
  to: string;
};

export function restorePhaseTransitionStatement(
  database: D1Database,
  input: RestorePhaseTransitionInput,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE catalogue_backup_attempts SET restore_phase = ?
     WHERE idempotency_key = ? AND owner_token = ?
       AND state = 'restoring_verification' AND restore_phase = ?`,
    )
    .bind(input.to, input.idempotencyKey, input.ownerToken, input.from);
}
