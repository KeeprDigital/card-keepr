import { type IngestionRunState, ingestionRunTransitionSources, ingestionRunTransitionSql } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function currentCatalogueStateStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT current_revision_id, published_at
      FROM catalogue_state
      WHERE singleton = 1`);
}

export function currentOperationStateStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT active_ingestion_run_id,
              active_release_id AS active_production_release_id,
              active_release_expires_at AS active_production_release_expires_at,
              active_recovery_id, recovery_health
      FROM operation_state
      WHERE singleton = 1`);
}

export function runByIdStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare("SELECT * FROM ingestion_runs WHERE id = ?").bind(runId);
}

export function publicationCleanupStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function releaseActiveRunLockStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1 AND active_ingestion_run_id = ?`)
    .bind(runId);
}

export function expireOverdueRunsStatement(database: D1Database, observedAt: string): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
        SET state = 'expired',
            terminal_at = approval_deadline,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'expired'
            )
        WHERE ${ingestionRunTransitionSql("awaiting_approval", "expired")}
          AND approval_deadline IS NOT NULL
          AND approval_deadline <= ?`)
    .bind(observedAt);
}

export function releaseTerminalRunLockStatement(database: D1Database, activeStatesJson: string): D1PreparedStatement {
  return database
    .prepare(`UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1
        AND active_ingestion_run_id IS NOT NULL
        AND (
          active_ingestion_run_id IN (
            SELECT id
            FROM ingestion_runs
            WHERE state = 'expired'
          )
          OR NOT EXISTS (
            SELECT 1
            FROM ingestion_runs
            WHERE id = operation_state.active_ingestion_run_id
              AND state IN (SELECT value FROM json_each(?))
          )
        )`)
    .bind(activeStatesJson);
}

export function failRunStatement(
  database: D1Database,
  input: Readonly<{ terminalAt: string; failureCode: string; runId: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
        SET state = 'failed',
            terminal_at = ?,
            failure_code = ?,
            progress_json = json_set(
              progress_json,
              '$.current_stage',
              'failed'
            )
        WHERE id = ?
          AND ${ingestionRunTransitionSql(ingestionRunTransitionSources("failed"), "failed")}`)
    .bind(input.terminalAt, input.failureCode, input.runId);
}

export function runEvidencePlanStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare("SELECT ingestion_run_id FROM ingestion_evidence_plans WHERE ingestion_run_id = ?")
    .bind(runId);
}

export function rejectRunStatement(
  database: D1Database,
  input: Readonly<{ terminalAt: string; progressJson: string; approvalHistoryJson: string; runId: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
          SET state = 'rejected',
              terminal_at = ?,
              progress_json = ?,
              approval_history_json = ?
          WHERE id = ? AND ${ingestionRunTransitionSql("awaiting_approval", "rejected")}`)
    .bind(input.terminalAt, input.progressJson, input.approvalHistoryJson, input.runId);
}

export function createFixtureRunStatement(
  database: D1Database,
  input: Readonly<{
    runId: string;
    selectedGamesJson: string;
    startedAt: string;
    expectedRevisionId: string;
    linkedRunId: string | null;
    idempotencyKey: string;
    operationalRequestId: string | null;
    candidateJson: string;
    progressJson: string;
    diagnosticsJson: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO ingestion_runs (
            id,
            state,
            selected_games_json,
            started_at,
            expected_current_revision_id,
            linked_run_id,
            idempotency_key,
            operational_request_id,
            candidate_digest,
            candidate_catalogue_digest,
            candidate_created_at,
            approval_deadline,
            approval_json,
            published_revision_id,
            export_manifest_digest,
            terminal_at,
            candidate_json,
            approval_idempotency_key,
            failure_code,
            progress_json,
            warnings_json,
            approval_history_json,
            publication_outcome,
            resulting_revision_id,
            freshness_checked_at
          ) VALUES (
            ?, 'planning', ?, ?, ?, ?, ?, ?,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL,
            NULL, ?, ?, '[]', NULL, NULL, NULL
          )`)
    .bind(
      input.runId,
      input.selectedGamesJson,
      input.startedAt,
      input.expectedRevisionId,
      input.linkedRunId,
      input.idempotencyKey,
      input.operationalRequestId,
      input.candidateJson,
      input.progressJson,
      input.diagnosticsJson,
    );
}

export function acquireRunLockStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database
    .prepare(`UPDATE operation_state
           SET active_ingestion_run_id = ?
           WHERE singleton = 1
             AND active_ingestion_run_id IS NULL
             AND recovery_health <> 'blocked'`)
    .bind(runId);
}

export function failFixtureRunStatement(
  database: D1Database,
  input: Readonly<{
    candidateDigest: string;
    candidateCreatedAt: string;
    approvalDeadline: string;
    terminalAt: string;
    failureCode: string | null;
    progressJson: string;
    runId: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
           SET state = 'failed',
               candidate_digest = ?,
               candidate_catalogue_digest = ?,
               candidate_created_at = ?,
               approval_deadline = ?,
               terminal_at = ?,
               failure_code = ?,
               progress_json = ?
           WHERE id = ? AND ${ingestionRunTransitionSql("planning", "failed")}`)
    .bind(
      input.candidateDigest,
      input.candidateDigest,
      input.candidateCreatedAt,
      input.approvalDeadline,
      input.terminalAt,
      input.failureCode,
      input.progressJson,
      input.runId,
    );
}

export function completeFixtureRunStatement(
  database: D1Database,
  input: Readonly<{
    candidateDigest: string;
    candidateCreatedAt: string;
    approvalDeadline: string;
    progressJson: string;
    runId: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
          SET state = 'awaiting_approval',
              candidate_digest = ?,
              candidate_catalogue_digest = ?,
              candidate_created_at = ?,
              approval_deadline = ?,
              progress_json = ?
          WHERE id = ? AND ${ingestionRunTransitionSql("reconciling", "awaiting_approval")}`)
    .bind(
      input.candidateDigest,
      input.candidateDigest,
      input.candidateCreatedAt,
      input.approvalDeadline,
      input.progressJson,
      input.runId,
    );
}

export function runHasEvidencePlanStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare("SELECT 1 AS present FROM ingestion_evidence_plans WHERE ingestion_run_id = ?").bind(runId);
}

export function transitionRunStatement(
  database: D1Database,
  input: Readonly<{ runId: string; from: IngestionRunState; to: IngestionRunState; progressJson: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
      SET state = ?, progress_json = ?
      WHERE id = ? AND ${ingestionRunTransitionSql(input.from, input.to)}`)
    .bind(input.to, input.progressJson, input.runId);
}
