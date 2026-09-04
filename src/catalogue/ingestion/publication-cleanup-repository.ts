import { type CatalogueStore, ingestionRunTransitionSql, repositoryStatements } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function retainedPublicationCleanupStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function claimPublicationCleanupStatement(
  database: CatalogueStore,
  input: Readonly<{
    observedAt: string;
    objectKeysJson: string;
    idempotencyKey: string | null;
    requestJson: string | null;
    claimToken: string;
    expiresAt: string;
    runId: string;
    priorClaimVersion: number;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_publication_cleanup
      SET state = 'cleaning',
          attempts = attempts + 1,
          failure_code = NULL,
          last_attempt_at = ?,
          object_keys_json = ?,
          idempotency_key = ?,
          request_json = ?,
          claim_token = ?,
          claim_version = claim_version + 1,
          claim_expires_at = ?
      WHERE ingestion_run_id = ?
        AND claim_version = ?
        AND (
          state IN ('pending', 'failed')
          OR (
            state = 'cleaning'
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ?
          )
        )
      RETURNING *`)
    .bind(
      input.observedAt,
      input.objectKeysJson,
      input.idempotencyKey,
      input.requestJson,
      input.claimToken,
      input.expiresAt,
      input.runId,
      input.priorClaimVersion,
      input.observedAt,
    );
}

export function completePublicationCleanupStatement(
  database: CatalogueStore,
  input: Readonly<{ completedAt: string; runId: string; claimToken: string; claimVersion: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_publication_cleanup
        SET state = 'completed',
            failure_code = NULL,
            completed_at = ?,
            claim_token = NULL,
            claim_version = claim_version + 1,
            claim_expires_at = NULL
        WHERE ingestion_run_id = ?
          AND state = 'cleaning'
          AND claim_token = ?
          AND claim_version = ?
        RETURNING *`)
    .bind(input.completedAt, input.runId, input.claimToken, input.claimVersion);
}

export function failPublicationCleanupStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; claimToken: string; claimVersion: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_publication_cleanup
        SET state = 'failed',
            failure_code = 'publication_cleanup_failed',
            claim_token = NULL,
            claim_version = claim_version + 1,
            claim_expires_at = NULL
        WHERE ingestion_run_id = ?
          AND state = 'cleaning'
          AND claim_token = ?
          AND claim_version = ?`)
    .bind(input.runId, input.claimToken, input.claimVersion);
}

export function failCandidatePublicationStatement(
  database: CatalogueStore,
  input: Readonly<{ terminalAt: string; failureCode: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
        SET state = 'failed',
            terminal_at = ?,
            failure_code = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'failed'
            )
        WHERE id = ? AND ${ingestionRunTransitionSql("awaiting_approval", "failed")}`)
    .bind(input.terminalAt, input.failureCode, input.runId);
}

export function failPublicationEvidencePlanStatement(
  database: CatalogueStore,
  input: Readonly<{ failureCode: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_evidence_plans
        SET failure_code = ?
        WHERE ingestion_run_id = ?`)
    .bind(input.failureCode, input.runId);
}

export function recordApprovalFailureStatement(
  database: CatalogueStore,
  input: Readonly<{
    key: string;
    requestJson: string;
    responseJson: string;
    status: number;
    createdAt: string;
    ownerToken: string | null;
    claimVersion: number | null;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO administration_idempotency (
          idempotency_key,
          operation,
          request_json,
          response_json,
          http_status,
          outcome,
          created_at,
          claim_owner_token,
          claim_version
        ) VALUES (
          ?, 'approve_ingestion_run', ?, ?, ?, 'problem', ?, ?, ?
        )`)
    .bind(
      input.key,
      input.requestJson,
      input.responseJson,
      input.status,
      input.createdAt,
      input.ownerToken,
      input.claimVersion,
    );
}

export function failReservedPublicationStatement(
  database: CatalogueStore,
  input: Readonly<{ terminalAt: string; failureCode: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
        SET state = 'failed',
            terminal_at = ?,
            failure_code = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'failed'
            )
        WHERE id = ? AND ${ingestionRunTransitionSql("publishing", "failed")}`)
    .bind(input.terminalAt, input.failureCode, input.runId);
}

export function schedulePublicationCleanupStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; objectKeysJson: string; notBefore: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_publication_cleanup (
            ingestion_run_id,
            state,
            object_keys_json,
            attempts,
            failure_code,
            last_attempt_at,
            completed_at,
            not_before,
            idempotency_key,
            request_json
          ) VALUES (?, 'pending', ?, 0, NULL, NULL, NULL, ?, NULL, NULL)
          ON CONFLICT (ingestion_run_id) DO NOTHING`)
    .bind(input.runId, input.objectKeysJson, input.notBefore);
}
