import { assertCuratedGamesUnblocked, prepareCuratedRevisionRunStart } from "../curated";
import {
  AdministrationProblem,
  assertIngestionRunTransition,
  type CatalogueCandidate,
  canonicalJson,
  isTerminalIngestionRunState,
  type SupportedGame,
  sha256,
} from "../shared";
import {
  idempotencyCompletionStatements,
  idempotentAdministration,
  replayAfterConflict,
} from "./administration-idempotency";
import { parseCandidate, validatedCatalogueCandidate } from "./candidate-codec";
import { attemptPublicationCleanup } from "./publication-cleanup";
import { reconcileAbandonedPublication } from "./publication-lifecycle";
import { progressFor, publicRun, terminalProgress } from "./run-document-codec";
import {
  acquireRunLockStatement,
  completeFixtureRunStatement,
  createFixtureRunStatement,
  failFixtureRunStatement,
  rejectRunStatement,
  runEvidencePlanStatement,
} from "./run-lifecycle-repository";
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
import { assertOpaqueId, assertSha256, errorMessage, parseSelectedGames } from "./run-values";

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
      if (!isTerminalIngestionRunState(source.state)) {
        throw new AdministrationProblem(
          409,
          "source_run_not_terminal",
          "Only a terminal Ingestion Run can be retried.",
        );
      }
      const evidencePlan = await runEvidencePlanStatement(database, source.id).first<{ ingestion_run_id: string }>();
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
  assertIngestionRunTransition(run.state, "rejected", {
    invalid: () =>
      new AdministrationProblem(409, "run_not_awaiting_approval", "The Ingestion Run is not awaiting approval."),
  });
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
      rejectRunStatement(database, {
        terminalAt: now,
        progressJson: JSON.stringify(rejectedProgress),
        approvalHistoryJson: JSON.stringify([decision]),
        runId: run.id,
      }),
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
      createFixtureRunStatement(database, {
        runId: runId,
        selectedGamesJson: JSON.stringify(input.selectedGames),
        startedAt: startedAt,
        expectedRevisionId: catalogueState.current_revision_id,
        linkedRunId: input.linkedRunId,
        idempotencyKey: input.idempotencyKey,
        operationalRequestId: input.operationalRequestId,
        candidateJson: candidateJson,
        progressJson: JSON.stringify(progressFor("planning")),
        diagnosticsJson: canonicalJson(curated.diagnostics),
      }),
      ...curatedPinStatements,
      ...(curatedFailure
        ? [
            acquireRunLockStatement(database, runId),
            failFixtureRunStatement(database, {
              candidateDigest: candidateDigest,
              candidateCreatedAt: startedAt,
              approvalDeadline: approvalDeadline,
              terminalAt: startedAt,
              failureCode: curated.failureCode,
              progressJson: JSON.stringify(progressFor("failed")),
              runId: runId,
            }),
            releaseRunLockStatement(database, runId),
          ]
        : [
            acquireRunLockStatement(database, runId),
            transitionStatement(database, runId, "planning", "collecting"),
            transitionStatement(database, runId, "collecting", "parsing"),
            transitionStatement(database, runId, "parsing", "reconciling"),
            completeFixtureRunStatement(database, {
              candidateDigest: candidateDigest,
              candidateCreatedAt: startedAt,
              approvalDeadline: approvalDeadline,
              progressJson: JSON.stringify(progressFor("awaiting_approval")),
              runId: runId,
            }),
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
