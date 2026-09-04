import {
  AdministrationProblem,
  assertIngestionRunTransition,
  CatalogueExportLimitError,
  type IngestionRunState,
  ingestionRunStates,
  isTerminalIngestionRunState,
} from "../shared";
import { progressFor } from "./run-document-codec";
import {
  currentCatalogueStateStatement,
  currentOperationStateStatement,
  expireOverdueRunsStatement,
  failRunStatement,
  publicationCleanupStatement,
  releaseActiveRunLockStatement,
  releaseTerminalRunLockStatement,
  runByIdStatement,
  transitionRunStatement,
} from "./run-lifecycle-repository";
import {
  type ApproveRunRequest,
  type CatalogueStateRow,
  type OperationStateRow,
  type PublicationCleanupRow,
  publicationLeaseMilliseconds,
  type RunRow,
} from "./run-types";
import { errorMessage } from "./run-values";

export function assertRunIsApprovable(run: RunRow, request: ApproveRunRequest): void {
  if (run.state === "expired") {
    throw new AdministrationProblem(409, "candidate_expired", "The candidate approval deadline has passed.");
  }
  assertIngestionRunTransition(run.state, "publishing", {
    invalid: () =>
      new AdministrationProblem(409, "run_not_awaiting_approval", "The Ingestion Run is not awaiting approval."),
  });
  if (run.candidate_digest !== request.candidate_digest) {
    throw new AdministrationProblem(
      409,
      "candidate_digest_mismatch",
      "The candidate digest no longer matches the requested approval.",
    );
  }
}

export async function throwApprovalFailure(
  database: D1Database,
  run: RunRow,
  error: unknown,
  now: string,
): Promise<never> {
  const message = errorMessage(error);
  await expireOverdueRuns(database, now);
  const guardedRun = await requiredRun(database, run.id);
  if (guardedRun.state === "expired") {
    throw new AdministrationProblem(409, "candidate_expired", "The candidate approval deadline has passed.");
  }
  if (message.includes("run_not_active")) {
    throw new AdministrationProblem(409, "run_not_active", "The active Ingestion Run identity no longer matches.");
  }
  if (
    message.includes("publication_guard_failed") ||
    message.includes("approval_guard_failed") ||
    message.includes("no_change_guard_failed")
  ) {
    const [catalogue, operation] = await Promise.all([
      currentCatalogueState(database),
      currentOperationState(database),
    ]);
    if (catalogue.current_revision_id !== run.expected_current_revision_id) {
      throw new AdministrationProblem(
        409,
        "current_revision_mismatch",
        "The current Catalogue Revision no longer matches the requested approval.",
      );
    }
    if (operation.active_ingestion_run_id !== run.id) {
      throw new AdministrationProblem(409, "run_not_active", "The active Ingestion Run identity no longer matches.");
    }
    if (operation.recovery_health !== "healthy") {
      throw new AdministrationProblem(
        409,
        "recovery_not_verified",
        "Recovery is not healthy, so publication is blocked.",
      );
    }
    throw new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The publication guards changed before the approval could commit.",
    );
  }
  await failRun(database, run.id, now, "export_verification_failed");
  throw new AdministrationProblem(
    500,
    "export_verification_failed",
    "The Catalogue Export could not be verified, so no revision was published.",
  );
}

export function publicationFailureProblem(error: unknown): AdministrationProblem {
  if (error instanceof CatalogueExportLimitError) {
    return new AdministrationProblem(
      422,
      "catalogue_export_too_large",
      "The candidate exceeds the bounded Catalogue Export relationship or byte budget, so no revision was published.",
    );
  }
  if (errorMessage(error).includes("publication_guard_failed")) {
    return new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The publication guards changed after approval was reserved.",
    );
  }
  return new AdministrationProblem(
    500,
    "export_verification_failed",
    "The Catalogue Export could not be verified, so no revision was published.",
  );
}

export async function requiredPublicationCleanup(database: D1Database, runId: string): Promise<PublicationCleanupRow> {
  const cleanup = await publicationCleanup(database, runId);
  if (cleanup === null) {
    throw new Error("The publication cleanup claim disappeared.");
  }
  return cleanup;
}

export function publicationCleanupNotBefore(run: RunRow, terminalAt: string): string {
  const reconcileAt =
    run.publication_reconcile_after === null ? Date.parse(terminalAt) : Date.parse(run.publication_reconcile_after);
  return new Date(Math.max(Date.parse(terminalAt), reconcileAt) + publicationLeaseMilliseconds).toISOString();
}

export async function currentCatalogueState(database: D1Database): Promise<CatalogueStateRow> {
  const state = await currentCatalogueStateStatement(database).first<CatalogueStateRow>();
  if (state === null) {
    throw new Error("Catalogue state is unavailable");
  }
  return state;
}

export async function currentOperationState(database: D1Database): Promise<OperationStateRow> {
  const state = await currentOperationStateStatement(database).first<OperationStateRow>();
  if (state === null) {
    throw new Error("Operation state is unavailable");
  }
  return state;
}

export async function requiredRun(database: D1Database, runId: string): Promise<RunRow> {
  const run = await runByIdStatement(database, runId).first<RunRow>();
  if (run === null) {
    throw new AdministrationProblem(404, "ingestion_run_not_found", "The requested Ingestion Run does not exist.");
  }
  return run;
}

export async function publicationCleanup(database: D1Database, runId: string): Promise<PublicationCleanupRow | null> {
  return publicationCleanupStatement(database, runId).first<PublicationCleanupRow>();
}

export function transitionStatement(
  database: D1Database,
  runId: string,
  from: IngestionRunState,
  to: IngestionRunState,
): D1PreparedStatement {
  return transitionRunStatement(database, { runId, from, to, progressJson: JSON.stringify(progressFor(to)) });
}

export function releaseRunLockStatement(database: D1Database, runId: string): D1PreparedStatement {
  return releaseActiveRunLockStatement(database, runId);
}

export async function expireOverdueRuns(database: D1Database, observedAt: string): Promise<void> {
  await database.batch([
    expireOverdueRunsStatement(database, observedAt),
    releaseTerminalRunLockStatement(
      database,
      JSON.stringify(ingestionRunStates.filter((state) => !isTerminalIngestionRunState(state))),
    ),
  ]);
}

async function failRun(database: D1Database, runId: string, terminalAt: string, failureCode: string): Promise<void> {
  await database.batch([
    failRunStatement(database, { terminalAt: terminalAt, failureCode: failureCode, runId: runId }),
    releaseRunLockStatement(database, runId),
  ]);
}
