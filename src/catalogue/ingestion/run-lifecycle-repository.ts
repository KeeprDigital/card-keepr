import { expireRunEventsStatement } from "../shared";
import {
  runEventCommand,
  runEventIdentitySql,
  runEventStatement,
  runCompletedStageCount,
  createRunEventStatement,
} from "../shared";
import { curatedRunStartGuardStatement } from "../curated";
import {
  type CatalogueStore,
  type IngestionRunState,
  ingestionRunTransitionSources,
  ingestionRunTransitionSql,
  repositoryStatements,
  runStartGuardStatement,
  runTransitionGuardStatement,
} from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function currentCatalogueStateStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT current_revision_id, published_at
      FROM catalogue_state
      WHERE singleton = 1`);
}

export function currentOperationStateStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT active_ingestion_run_id,
              active_production_release_id,
              active_production_release_expires_at,
              active_recovery_id, recovery_health
      FROM operation_state
      WHERE singleton = 1`);
}

export function runByIdStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT * FROM ingestion_run_read WHERE id = ?").bind(runId);
}

export function publicationCleanupStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT *
      FROM ingestion_publication_cleanup
      WHERE ingestion_run_id = ?`)
    .bind(runId);
}

export function releaseActiveRunLockStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1 AND active_ingestion_run_id = ?`)
    .bind(runId);
}

export function expireOverdueRunsStatement(database: CatalogueStore, observedAt: string): D1PreparedStatement {
  return expireRunEventsStatement(database, observedAt);
}

export function releaseTerminalRunLockStatement(
  database: CatalogueStore,
  activeStatesJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1
        AND active_ingestion_run_id IS NOT NULL
        AND (
          active_ingestion_run_id IN (
            SELECT ingestion_run_id
            FROM ingestion_run_current
            WHERE state = 'expired'
          )
          OR NOT EXISTS (
            SELECT 1
            FROM ingestion_run_current
            WHERE ingestion_run_id = operation_state.active_ingestion_run_id
              AND state IN (SELECT value FROM json_each(?))
          )
        )`)
    .bind(activeStatesJson);
}

export function failRunStatement(
  database: CatalogueStore,
  input: Readonly<{ terminalAt: string; failureCode: string; runId: string }>,
): D1PreparedStatement {
  const event = runEventCommand("failed", { runId: input.runId, occurredAt: input.terminalAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
        SET ${runEventIdentitySql}, state = 'failed',
            terminal_at = ?,
            failure_code = ?
        WHERE ingestion_run_id = ?
          AND ${ingestionRunTransitionSql(ingestionRunTransitionSources("failed"), "failed")}`)
    .bind(event.eventId, input.terminalAt, input.failureCode, input.runId);
  return runEventStatement(database, { event, statement, before: [failActiveRunGuardStatement(database, input)] });
}

export function runEvidencePlanStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT ingestion_run_id FROM ingestion_evidence_plans WHERE ingestion_run_id = ?")
    .bind(runId);
}

export function rejectRunStatement(
  database: CatalogueStore,
  input: Readonly<{ terminalAt: string; progressJson: string; decisionJson: string; runId: string }>,
): D1PreparedStatement {
  const event = runEventCommand("rejected", { runId: input.runId, occurredAt: input.terminalAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
          SET ${runEventIdentitySql}, state = 'rejected',
              terminal_at = ?,
              completed_stage_count = ?
          WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql("awaiting_approval", "rejected")}`)
    .bind(event.eventId, input.terminalAt, runCompletedStageCount(input.progressJson), input.runId);
  return runEventStatement(database, {
    event,
    statement,
    decisionJson: input.decisionJson,
    guards: [runTransitionGuardStatement(database, { runId: input.runId, from: "awaiting_approval", to: "rejected" })],
  });
}

export function createFixtureRunStatement(
  database: CatalogueStore,
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
  return createRunEventStatement(database, {
    runId: input.runId,
    selectedGamesJson: input.selectedGamesJson,
    startedAt: input.startedAt,
    expectedRevisionId: input.expectedRevisionId,
    linkedRunId: input.linkedRunId,
    idempotencyKey: input.idempotencyKey,
    operationalRequestId: input.operationalRequestId,
    state: "planning",
    candidateJson: input.candidateJson,
    diagnosticsJson: input.diagnosticsJson,
    guards: [runStartGuardStatement(database), curatedRunStartGuardStatement(database, input.runId)],
  });
}

export function acquireRunLockStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state
           SET active_ingestion_run_id = ?
           WHERE singleton = 1
             AND active_ingestion_run_id IS NULL
             AND recovery_health <> 'blocked'`)
    .bind(runId);
}

export function failFixtureRunStatement(
  database: CatalogueStore,
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
  const event = runEventCommand("candidate_blocked", { runId: input.runId, occurredAt: input.terminalAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
           SET ${runEventIdentitySql}, state = 'failed',
               candidate_digest = ?,
               candidate_catalogue_digest = ?,
               candidate_created_at = ?,
               approval_deadline = ?,
               terminal_at = ?,
               failure_code = ?,
               completed_stage_count = ?
           WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql("planning", "failed")}`)
    .bind(
      event.eventId,
      input.candidateDigest,
      input.candidateDigest,
      input.candidateCreatedAt,
      input.approvalDeadline,
      input.terminalAt,
      input.failureCode,
      runCompletedStageCount(input.progressJson),
      input.runId,
    );
  return runEventStatement(database, {
    event,
    statement,
    guards: [runTransitionGuardStatement(database, { runId: input.runId, from: "planning", to: "failed" })],
  });
}

export function completeFixtureRunStatement(
  database: CatalogueStore,
  input: Readonly<{
    candidateDigest: string;
    candidateCreatedAt: string;
    approvalDeadline: string;
    progressJson: string;
    runId: string;
  }>,
): D1PreparedStatement {
  const event = runEventCommand("candidate_prepared", { runId: input.runId, occurredAt: input.candidateCreatedAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
          SET ${runEventIdentitySql}, state = 'awaiting_approval',
              candidate_digest = ?,
              candidate_catalogue_digest = ?,
              candidate_created_at = ?,
              approval_deadline = ?,
              completed_stage_count = ?
          WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql("reconciling", "awaiting_approval")}`)
    .bind(
      event.eventId,
      input.candidateDigest,
      input.candidateDigest,
      input.candidateCreatedAt,
      input.approvalDeadline,
      runCompletedStageCount(input.progressJson),
      input.runId,
    );
  return runEventStatement(database, {
    event,
    statement,
    guards: [
      runTransitionGuardStatement(database, { runId: input.runId, from: "reconciling", to: "awaiting_approval" }),
    ],
  });
}

export function runHasEvidencePlanStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT 1 AS present FROM ingestion_evidence_plans WHERE ingestion_run_id = ?")
    .bind(runId);
}

export function transitionRunStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; from: IngestionRunState; to: IngestionRunState; progressJson: string }>,
): D1PreparedStatement {
  const event = runEventCommand("stage_changed", { runId: input.runId });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
      SET ${runEventIdentitySql}, state = ?, completed_stage_count = ?
      WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql(input.from, input.to)}`)
    .bind(event.eventId, input.to, runCompletedStageCount(input.progressJson), input.runId);
  return runEventStatement(database, { event, statement, guards: [runTransitionGuardStatement(database, input)] });
}

function failActiveRunGuardStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; failureCode: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ingestion_run_current AS run WHERE ingestion_run_id = ?
      AND ${ingestionRunTransitionSql(ingestionRunTransitionSources("failed"), "failed")}
      AND NOT EXISTS (SELECT 1 FROM operation_state WHERE singleton = 1 AND active_ingestion_run_id = run.ingestion_run_id)
      AND NOT (run.state = 'publishing' AND ? IN (
        'publication_abandoned', 'publication_precondition_failed', 'export_verification_failed'
      ))
  ) THEN 1 ELSE json_extract('{}', 'run_not_active') END`)
    .bind(input.runId, input.failureCode);
}
