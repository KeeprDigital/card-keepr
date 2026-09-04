import { assertCuratedGamesUnblocked, prepareCuratedRevisionRunStart } from "../curated";
import { AdministrationProblem, type CatalogueCandidate, canonicalJson, type SupportedGame, sha256 } from "../shared";
import { idempotencyCompletionStatements } from "./administration-idempotency";
import { idempotentAdministration, replayAfterConflict } from "./administration-idempotency";
import { parseCandidate, validatedCatalogueCandidate } from "./candidate-codec";
import { attemptPublicationCleanup } from "./publication-cleanup";
import { reconcileAbandonedPublication } from "./publication-lifecycle";
import { progressFor, publicRun, terminalProgress } from "./run-document-codec";
import {
  currentCatalogueState,
  currentOperationState,
  expireOverdueRuns,
  publicationCleanup,
  releaseRunLockStatement,
  requiredRun,
  transitionStatement,
} from "./run-storage";
import {
  type IdempotencyClaimOwner,
  type RejectRunRequest,
  type RetryPublicationCleanupRequest,
  type RetryRunRequest,
  type StartRunRequest,
  sevenDaysInMilliseconds,
} from "./run-types";
import { assertOpaqueId, assertSha256, errorMessage, parseSelectedGames, terminalRunStates } from "./run-values";

export async function startFixtureRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  request: StartRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    fixture: request.fixture,
    selected_games: request.selected_games,
  });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "start_ingestion_run",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      const candidate = await validatedCatalogueCandidate(request);
      return startPreparedRun(database, {
        candidate: candidate.candidate,
        selectedGames: candidate.candidate.selected_games,
        idempotencyKey: request.idempotency_key,
        operationalRequestId: request.operational_request_id ?? null,
        idempotencyOperation: "start_ingestion_run",
        idempotencyRequestJson: requestJson,
        linkedRunId: null,
        observedAt,
        claimOwner,
      });
    },
  );
}

export async function retryRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  sourceRunId: string,
  request: RetryRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(sourceRunId, "run_id");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({ source_run_id: sourceRunId });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "retry_ingestion_run",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      const source = await requiredRun(database, sourceRunId);
      if (!terminalRunStates.has(source.state)) {
        throw new AdministrationProblem(
          409,
          "source_run_not_terminal",
          "Only a terminal Ingestion Run can be retried.",
        );
      }
      const evidencePlan = await database
        .prepare("SELECT ingestion_run_id FROM ingestion_evidence_plans WHERE ingestion_run_id = ?")
        .bind(source.id)
        .first<{ ingestion_run_id: string }>();
      if (evidencePlan !== null) {
        throw new AdministrationProblem(
          409,
          "evidence_retry_required",
          "Evidence-backed runs must be retried through their linked collection workflow so immutable provenance is retained.",
        );
      }
      const candidate = parseCandidate(source);
      return startPreparedRun(database, {
        candidate,
        selectedGames: parseSelectedGames(source.selected_games_json),
        idempotencyKey: request.idempotency_key,
        operationalRequestId: request.operational_request_id ?? null,
        idempotencyOperation: "retry_ingestion_run",
        idempotencyRequestJson: requestJson,
        linkedRunId: source.id,
        observedAt,
        claimOwner,
      });
    },
  );
}

export async function retryPublicationCleanup(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: RetryPublicationCleanupRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({ run_id: runId });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "retry_publication_cleanup",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      const result = await attemptPublicationCleanup(database, catalogueExports, runId, observedAt, {
        key: request.idempotency_key,
        requestJson,
        claimOwner,
      });
      if (result === null) {
        throw new Error("Publication cleanup did not produce an administration result.");
      }
      return result;
    },
  );
}

export async function showRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, observedAt);
  await reconcileAbandonedPublication(database, catalogueExports, observedAt);
  assertOpaqueId(runId, "run_id");
  const run = await requiredRun(database, runId);
  return publicRun(run, await publicationCleanup(database, run.id));
}

export async function rejectRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: RejectRunRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  assertSha256(request.candidate_digest, "candidate_digest");
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    run_id: runId,
    candidate_digest: request.candidate_digest,
  });
  return idempotentAdministration(
    database,
    {
      key: request.idempotency_key,
      operation: "reject_ingestion_run",
      requestJson,
      observedAt,
    },
    async (claimOwner) => {
      await expireOverdueRuns(database, observedAt);
      await reconcileAbandonedPublication(database, catalogueExports, observedAt);
      return rejectRunAttempt(database, runId, request, requestJson, observedAt, claimOwner);
    },
  );
}

async function rejectRunAttempt(
  database: D1Database,
  runId: string,
  request: RejectRunRequest,
  requestJson: string,
  now: string,
  claimOwner: IdempotencyClaimOwner,
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, now);
  const run = await requiredRun(database, runId);
  if (run.state === "expired") {
    throw new AdministrationProblem(409, "candidate_expired", "The candidate approval deadline has passed.");
  }
  if (run.state !== "awaiting_approval") {
    throw new AdministrationProblem(409, "run_not_awaiting_approval", "The Ingestion Run is not awaiting approval.");
  }
  if (run.candidate_digest !== request.candidate_digest) {
    throw new AdministrationProblem(
      409,
      "candidate_digest_mismatch",
      "The candidate digest no longer matches the requested rejection.",
    );
  }
  const decision = {
    action: "rejected",
    rejected_at: now,
    candidate_digest: request.candidate_digest,
  };
  const rejectedProgress = terminalProgress(run, "rejected");
  const resultingRun = publicRun({
    ...run,
    state: "rejected",
    terminal_at: now,
    progress_json: JSON.stringify(rejectedProgress),
    approval_history_json: JSON.stringify([decision]),
  });
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'rejected',
              terminal_at = ?,
              progress_json = ?,
              approval_history_json = ?
          WHERE id = ? AND state = 'awaiting_approval'`,
        )
        .bind(now, JSON.stringify(rejectedProgress), JSON.stringify([decision]), run.id),
      releaseRunLockStatement(database, run.id),
      ...idempotencyCompletionStatements(database, {
        key: request.idempotency_key,
        operation: "reject_ingestion_run",
        requestJson,
        response: resultingRun,
        status: 200,
        createdAt: now,
        claimOwner,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      request.idempotency_key,
      "reject_ingestion_run",
      requestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    if (errorMessage(error).includes("run_not_active")) {
      throw new AdministrationProblem(409, "run_not_active", "The active Ingestion Run identity no longer matches.");
    }
    throw error;
  }
  return resultingRun;
}

async function startPreparedRun(
  database: D1Database,
  input: {
    candidate: CatalogueCandidate;
    selectedGames: readonly SupportedGame[];
    idempotencyKey: string;
    operationalRequestId: string | null;
    idempotencyOperation: string;
    idempotencyRequestJson: string;
    linkedRunId: string | null;
    observedAt: string;
    claimOwner: IdempotencyClaimOwner;
  },
): Promise<Record<string, unknown>> {
  await expireOverdueRuns(database, input.observedAt);
  const [catalogueState, operationState] = await Promise.all([
    currentCatalogueState(database),
    currentOperationState(database),
  ]);
  if (operationState.active_ingestion_run_id !== null) {
    throw new AdministrationProblem(409, "active_ingestion_run", "Another Ingestion Run is already active.");
  }
  if (operationState.recovery_health === "blocked") {
    throw new AdministrationProblem(409, "recovery_in_progress", "Recovery blocks new Ingestion Runs.");
  }
  await assertCuratedGamesUnblocked(database, input.selectedGames);

  const startedAt = input.observedAt;
  const approvalDeadline = new Date(Date.parse(startedAt) + sevenDaysInMilliseconds).toISOString();
  const runId = `run_${crypto.randomUUID()}`;
  const curated = await prepareCuratedRevisionRunStart(
    database,
    runId,
    input.selectedGames,
    input.candidate,
    startedAt,
  );
  const candidateJson = canonicalJson(curated.candidate);
  const candidateDigest = await sha256(new TextEncoder().encode(candidateJson));
  const curatedFailure = curated.failureCode !== null;
  const resultingRun = publicRun({
    id: runId,
    state: curatedFailure ? "failed" : "awaiting_approval",
    selected_games_json: JSON.stringify(input.selectedGames),
    started_at: startedAt,
    expected_current_revision_id: catalogueState.current_revision_id,
    linked_run_id: input.linkedRunId,
    idempotency_key: input.idempotencyKey,
    operational_request_id: input.operationalRequestId,
    candidate_digest: candidateDigest,
    candidate_catalogue_digest: candidateDigest,
    candidate_created_at: startedAt,
    approval_deadline: approvalDeadline,
    approval_json: null,
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: curatedFailure ? startedAt : null,
    candidate_json: candidateJson,
    approval_idempotency_key: null,
    failure_code: curated.failureCode,
    progress_json: JSON.stringify(progressFor(curatedFailure ? "failed" : "awaiting_approval")),
    warnings_json: canonicalJson(curated.diagnostics),
    approval_history_json: "[]",
    publication_outcome: null,
    resulting_revision_id: null,
    freshness_checked_at: null,
    publication_revision_id: null,
    publication_started_at: null,
    publication_reconcile_after: null,
    publication_manifest_digest: null,
    publication_writer_token: null,
  });
  const curatedPinStatements = curated.statements;

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO ingestion_runs (
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
          )`,
        )
        .bind(
          runId,
          JSON.stringify(input.selectedGames),
          startedAt,
          catalogueState.current_revision_id,
          input.linkedRunId,
          input.idempotencyKey,
          input.operationalRequestId,
          candidateJson,
          JSON.stringify(progressFor("planning")),
          canonicalJson(curated.diagnostics),
        ),
      ...curatedPinStatements,
      ...(curatedFailure
        ? [
            database
              .prepare(
                `UPDATE operation_state
           SET active_ingestion_run_id = ?
           WHERE singleton = 1
             AND active_ingestion_run_id IS NULL
             AND recovery_health <> 'blocked'`,
              )
              .bind(runId),
            database
              .prepare(
                `UPDATE ingestion_runs
           SET state = 'failed',
               candidate_digest = ?,
               candidate_catalogue_digest = ?,
               candidate_created_at = ?,
               approval_deadline = ?,
               terminal_at = ?,
               failure_code = ?,
               progress_json = ?
           WHERE id = ? AND state = 'planning'`,
              )
              .bind(
                candidateDigest,
                candidateDigest,
                startedAt,
                approvalDeadline,
                startedAt,
                curated.failureCode,
                JSON.stringify(progressFor("failed")),
                runId,
              ),
            releaseRunLockStatement(database, runId),
          ]
        : [
            database
              .prepare(
                `UPDATE operation_state
          SET active_ingestion_run_id = ?
          WHERE singleton = 1
            AND active_ingestion_run_id IS NULL
            AND recovery_health <> 'blocked'`,
              )
              .bind(runId),
            transitionStatement(database, runId, "planning", "collecting"),
            transitionStatement(database, runId, "collecting", "parsing"),
            transitionStatement(database, runId, "parsing", "reconciling"),
            database
              .prepare(
                `UPDATE ingestion_runs
          SET state = 'awaiting_approval',
              candidate_digest = ?,
              candidate_catalogue_digest = ?,
              candidate_created_at = ?,
              approval_deadline = ?,
              progress_json = ?
          WHERE id = ? AND state = 'reconciling'`,
              )
              .bind(
                candidateDigest,
                candidateDigest,
                startedAt,
                approvalDeadline,
                JSON.stringify(progressFor("awaiting_approval")),
                runId,
              ),
          ]),
      ...idempotencyCompletionStatements(database, {
        key: input.idempotencyKey,
        operation: input.idempotencyOperation,
        requestJson: input.idempotencyRequestJson,
        response: resultingRun,
        status: 201,
        createdAt: startedAt,
        claimOwner: input.claimOwner,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      input.idempotencyKey,
      input.idempotencyOperation,
      input.idempotencyRequestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    if (errorMessage(error).includes("active_ingestion_run") || errorMessage(error).includes("run_not_active")) {
      throw new AdministrationProblem(409, "active_ingestion_run", "Another Ingestion Run is already active.");
    }
    if (errorMessage(error).includes("recovery_in_progress")) {
      throw new AdministrationProblem(409, "recovery_in_progress", "Recovery blocks new Ingestion Runs.");
    }
    if (errorMessage(error).includes("credential_execution_in_progress")) {
      throw new AdministrationProblem(
        409,
        "credential_execution_in_progress",
        "Credential execution blocks new Ingestion Runs.",
      );
    }
    throw error;
  }
  return resultingRun;
}
