import { initializeReconciliationProgress } from "./reconciliation-progress";
import {
  reconciliationOperationStatement,
  reconciliationRequestForRunStatement,
  pauseFailedReconciliationStatement,
} from "./reconciliation-progress-repository";
import {
  AdministrationProblem,
  assertIngestionRunTransition,
  type CatalogueStore,
  canonicalJson,
  type IngestionRunState,
  replayByDigest,
  sha256Text,
  workflowDriver,
} from "../shared";
import { assertIdentifier } from "../source-evidence";

import { retainedReconciliationResult } from "./reconciliation-candidate-store";
import {
  createReconciliationWorkflowRequestStatement,
  reconciliationWorkflowCandidateDigestStatement,
  reconciliationWorkflowRequestStatement,
  reconciliationWorkflowRunStatement,
} from "./reconciliation-workflow-repository";

export type ReconciliationWorkflowParams = Readonly<{
  ingestion_run_id: string;
  expected_current_revision_id: string;
  idempotency_key: string;
  observed_at: string;
  generation?: number;
}>;

type ReconciliationWorkflowRequestRow = {
  idempotency_key: string;
  ingestion_run_id: string;
  expected_current_revision_id: string;
  request_json: string;
  workflow_params_json: string;
  workflow_instance_id: string;
  observed_at: string;
};

export async function startOrObserveReconciliationWorkflow(
  database: CatalogueStore,
  workflow: Workflow<ReconciliationWorkflowParams>,
  input: Omit<ReconciliationWorkflowParams, "observed_at">,
  observedAt: string,
): Promise<{
  created: boolean;
  document: Record<string, unknown>;
}> {
  assertIdentifier(input.ingestion_run_id, "ingestion_run_id");
  assertIdentifier(input.expected_current_revision_id, "expected_current_revision_id");
  assertIdentifier(input.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson({
    ingestion_run_id: input.ingestion_run_id,
    expected_current_revision_id: input.expected_current_revision_id,
    idempotency_key: input.idempotency_key,
  });
  const replay = await workflowRequest(database, input.idempotency_key);
  if (replay !== null) {
    await assertExactReplay(replay, requestJson);
    return {
      created: false,
      document: await publicWorkflowRequest(database, workflow, replay),
    };
  }

  const run = await reconciliationWorkflowRunStatement(database, input.ingestion_run_id).first<{
    id: string;
    state: IngestionRunState;
    selected_games_json: string;
    expected_current_revision_id: string;
    current_revision_id: string;
    active_ingestion_run_id: string | null;
    recovery_health: string;
  }>();
  if (run === null) {
    throw new AdministrationProblem(404, "ingestion_run_not_found", "The requested Ingestion Run does not exist.");
  }
  if (
    run.current_revision_id !== input.expected_current_revision_id ||
    run.expected_current_revision_id !== input.expected_current_revision_id
  ) {
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The expected current Catalogue Revision is stale.",
    );
  }
  if (run.active_ingestion_run_id !== input.ingestion_run_id) {
    throw new AdministrationProblem(
      409,
      "run_not_active",
      "Only the active parsing Ingestion Run can start reconciliation.",
    );
  }
  assertIngestionRunTransition(run.state, "reconciling", {
    invalid: () =>
      new AdministrationProblem(
        409,
        "run_not_active",
        "Only the active parsing Ingestion Run can start reconciliation.",
      ),
  });
  if (run.recovery_health !== "healthy") {
    throw new AdministrationProblem(
      409,
      "recovery_not_verified",
      "Recovery is not healthy, so reconciliation is blocked.",
    );
  }

  const workflowInstanceId = `reconcile-${(await sha256Text(requestJson)).slice(0, 64)}`;
  const workflowParams: ReconciliationWorkflowParams = {
    ingestion_run_id: input.ingestion_run_id,
    expected_current_revision_id: input.expected_current_revision_id,
    idempotency_key: input.idempotency_key,
    observed_at: observedAt,
  };
  const workflowParamsJson = canonicalJson(workflowParams);
  await initializeReconciliationProgress(database, input.ingestion_run_id, observedAt);
  const insertion = await createReconciliationWorkflowRequestStatement(database, {
    games: JSON.parse(run.selected_games_json) as string[],
    idempotencyKey: input.idempotency_key,
    runId: input.ingestion_run_id,
    expectedRevisionId: input.expected_current_revision_id,
    requestJson: requestJson,
    paramsJson: workflowParamsJson,
    workflowId: workflowInstanceId,
    observedAt: observedAt,
  }).run();
  const stored = await workflowRequest(database, input.idempotency_key);
  if (stored === null) {
    throw new AdministrationProblem(
      409,
      "reconciliation_already_requested",
      "The Ingestion Run is already bound to another reconciliation request.",
    );
  }
  await assertExactReplay(stored, requestJson);
  const created = insertion.meta.changes === 1;
  return {
    created,
    document: await publicWorkflowRequest(database, workflow, stored, created),
  };
}

async function publicWorkflowRequest(
  database: CatalogueStore,
  workflow: Workflow<ReconciliationWorkflowParams>,
  request: ReconciliationWorkflowRequestRow,
  createRequested = false,
): Promise<Record<string, unknown>> {
  const operation = await reconciliationOperationStatement(database, request.ingestion_run_id).first<{
    state: string;
    generation: number;
  }>();
  const envelope = {
    contract: "card-keepr-reconciliation-workflow@1",
    ingestion_run_id: request.ingestion_run_id,
    expected_current_revision_id: request.expected_current_revision_id,
    idempotency_key: request.idempotency_key,
    workflow_instance_id: request.workflow_instance_id,
  };
  if (operation?.state === "paused" || operation?.state === "abandoned")
    return { ...envelope, status: operation.state, output: null };
  const generation = operation?.generation ?? 0;
  const createParams = { ...storedWorkflowParams(request), ...(generation > 0 ? { generation } : {}) };
  if (generation > 0) request = { ...request, workflow_instance_id: `${request.workflow_instance_id}-g${generation}` };
  const driver = workflowDriver(workflow);
  let { status } = await driver.ensure(request.workflow_instance_id, createParams, { createRequested });
  if (status.status === "paused") status = await driver.resume(request.workflow_instance_id);
  if (status.status === "errored" || status.status === "terminated") {
    const recovered = await recoverTerminalWorkflow(
      database,
      request,
      generation,
      status.error?.message ?? `The reconciliation Workflow became ${status.status}.`,
    );
    return {
      ...envelope,
      ...durableOutputStatus(recovered),
    };
  }
  const output =
    status.status === "complete" ? await workflowOutput(database, request, generation, status.output) : null;
  return {
    contract: "card-keepr-reconciliation-workflow@1",
    ingestion_run_id: request.ingestion_run_id,
    expected_current_revision_id: request.expected_current_revision_id,
    idempotency_key: request.idempotency_key,
    workflow_instance_id: request.workflow_instance_id,
    ...(output === null ? { status: status.status, output: null } : durableOutputStatus(output)),
  };
}

function durableOutputStatus(result: Record<string, unknown>) {
  return {
    status:
      result.state === "preparing"
        ? "running"
        : result.state === "paused" || result.state === "abandoned"
          ? result.state
          : "complete",
    output: ["preparing", "paused", "abandoned"].includes(String(result.state)) ? null : result,
  };
}

async function recoverTerminalWorkflow(
  database: CatalogueStore,
  request: ReconciliationWorkflowRequestRow,
  generation: number,
  detail: string,
): Promise<Record<string, unknown>> {
  const run = await reconciliationWorkflowCandidateDigestStatement(database, request.ingestion_run_id).first<{
    candidate_digest: string | null;
  }>();
  if (run === null) {
    throw new Error("The reconciliation Workflow run is unavailable.");
  }
  if (run.candidate_digest !== null) {
    return retainedReconciliationResult(database, request.ingestion_run_id);
  }
  await pauseFailedReconciliationStatement(database, request.ingestion_run_id, generation, detail).run();
  const current = await reconciliationOperationStatement(database, request.ingestion_run_id).first<{ state: string }>();
  if (current?.state === "sealed" || current?.state === "failed")
    return retainedReconciliationResult(database, request.ingestion_run_id);
  if (!current) throw new Error("The durable reconciliation operation is unavailable.");
  return { state: current.state, publishable: false, run_id: request.ingestion_run_id };
}

async function workflowOutput(
  database: CatalogueStore,
  request: ReconciliationWorkflowRequestRow,
  generation: number,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("result_json" in value) ||
    typeof value.result_json !== "string"
  ) {
    return recoverMalformedCompleteWorkflow(database, request, generation);
  }
  let reference: unknown;
  try {
    reference = JSON.parse(value.result_json) as unknown;
  } catch {
    return recoverMalformedCompleteWorkflow(database, request, generation);
  }
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
    return recoverMalformedCompleteWorkflow(database, request, generation);
  }
  const result = reference as Record<string, unknown>;
  if (result.contract !== "card-keepr-reconciliation-workflow-result@1") {
    return recoverMalformedCompleteWorkflow(database, request, generation);
  }
  if (result.run_id !== request.ingestion_run_id) {
    throw new Error("The reconciliation Workflow result is invalid.");
  }
  if (result.result !== null && typeof result.result === "object" && !Array.isArray(result.result)) {
    if (["preparing", "paused", "abandoned"].includes(String((result.result as Record<string, unknown>).state))) {
      const current = await reconciliationOperationStatement(database, request.ingestion_run_id).first<{
        state: string;
      }>();
      if (!current) throw new Error("The durable reconciliation operation is unavailable.");
      if (["preparing", "paused", "abandoned"].includes(current.state))
        return { state: current.state, run_id: request.ingestion_run_id, publishable: false };
      return retainedReconciliationResult(database, request.ingestion_run_id);
    }
    const retained = await retainedReconciliationResult(database, request.ingestion_run_id);
    if (canonicalJson(retained) !== canonicalJson(result.result as Record<string, unknown>)) {
      throw new Error("The reconciliation Workflow result does not bind the retained reconciliation.");
    }
    return retained;
  }
  if (typeof result.candidate_digest !== "string") {
    return recoverMalformedCompleteWorkflow(database, request, generation);
  }
  const retained = await retainedReconciliationResult(database, request.ingestion_run_id);
  if (retained.candidate_digest !== result.candidate_digest) {
    throw new Error("The reconciliation Workflow result does not bind the retained candidate.");
  }
  return retained;
}

function recoverMalformedCompleteWorkflow(
  database: CatalogueStore,
  request: ReconciliationWorkflowRequestRow,
  generation: number,
): Promise<Record<string, unknown>> {
  return recoverTerminalWorkflow(
    database,
    request,
    generation,
    "The completed reconciliation Workflow output was unavailable.",
  );
}

async function workflowRequest(
  database: CatalogueStore,
  idempotencyKey: string,
): Promise<ReconciliationWorkflowRequestRow | null> {
  return reconciliationWorkflowRequestStatement(database, idempotencyKey).first<ReconciliationWorkflowRequestRow>();
}

function storedWorkflowParams(request: ReconciliationWorkflowRequestRow): ReconciliationWorkflowParams {
  const parsed: unknown = JSON.parse(request.workflow_params_json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The persisted reconciliation Workflow params are invalid.");
  }
  const params = parsed as Record<string, unknown>;
  if (
    params.ingestion_run_id !== request.ingestion_run_id ||
    params.expected_current_revision_id !== request.expected_current_revision_id ||
    params.idempotency_key !== request.idempotency_key ||
    params.observed_at !== request.observed_at
  ) {
    throw new Error("The persisted reconciliation Workflow params are invalid.");
  }
  return params as ReconciliationWorkflowParams;
}

async function assertExactReplay(stored: ReconciliationWorkflowRequestRow, requestJson: string): Promise<void> {
  await replayByDigest({
    lookup: async () => stored,
    retainedDigest: (retained) => retained.request_json,
    requestDigest: requestJson,
    conflictDetail: "The reconciliation idempotency key is already bound to another request.",
  });
}

export async function resumeReconciliationWorkflow(
  database: CatalogueStore,
  workflow: Workflow<ReconciliationWorkflowParams>,
  runId: string,
) {
  const request = await reconciliationRequestForRunStatement(database, runId).first<ReconciliationWorkflowRequestRow>();
  if (request) await publicWorkflowRequest(database, workflow, request, true);
}
