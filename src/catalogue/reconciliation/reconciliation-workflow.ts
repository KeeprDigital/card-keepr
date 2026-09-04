import { AdministrationProblem, canonicalJson, sha256Text } from "../shared";
import { failReconciliationWorkflow, retainedReconciliationResult } from "./reconciliation-candidate-store";
import { assertIdentifier } from "../source-evidence";

export type ReconciliationWorkflowParams = Readonly<{
  ingestion_run_id: string;
  expected_current_revision_id: string;
  idempotency_key: string;
  observed_at: string;
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
  database: D1Database,
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
    assertExactReplay(replay, requestJson);
    return {
      created: false,
      document: await publicWorkflowRequest(database, workflow, replay),
    };
  }

  const run = await database
    .prepare(
      `SELECT run.id, run.state, run.expected_current_revision_id,
              state.current_revision_id, operation.active_ingestion_run_id,
              operation.recovery_health
       FROM ingestion_runs AS run
       CROSS JOIN catalogue_state AS state
       CROSS JOIN operation_state AS operation
       WHERE run.id = ?`,
    )
    .bind(input.ingestion_run_id)
    .first<{
      id: string;
      state: string;
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
  if (run.state !== "parsing" || run.active_ingestion_run_id !== input.ingestion_run_id) {
    throw new AdministrationProblem(
      409,
      "run_not_active",
      "Only the active parsing Ingestion Run can start reconciliation.",
    );
  }
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
  const insertion = await database
    .prepare(
      `INSERT OR IGNORE INTO reconciliation_workflow_requests (
         idempotency_key, ingestion_run_id,
         expected_current_revision_id, request_json,
         workflow_params_json, workflow_instance_id, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.idempotency_key,
      input.ingestion_run_id,
      input.expected_current_revision_id,
      requestJson,
      workflowParamsJson,
      workflowInstanceId,
      observedAt,
    )
    .run();
  const stored = await workflowRequest(database, input.idempotency_key);
  if (stored === null) {
    throw new AdministrationProblem(
      409,
      "reconciliation_already_requested",
      "The Ingestion Run is already bound to another reconciliation request.",
    );
  }
  assertExactReplay(stored, requestJson);
  const created = insertion.meta.changes === 1;
  return {
    created,
    document: await publicWorkflowRequest(database, workflow, stored, created),
  };
}

async function publicWorkflowRequest(
  database: D1Database,
  workflow: Workflow<ReconciliationWorkflowParams>,
  request: ReconciliationWorkflowRequestRow,
  createRequested = false,
): Promise<Record<string, unknown>> {
  const createParams = storedWorkflowParams(request);
  let instance: WorkflowInstance | null = null;
  let status: Awaited<ReturnType<WorkflowInstance["status"]>> | null = null;
  if (!createRequested) {
    try {
      instance = await workflow.get(request.workflow_instance_id);
      status = await instance.status();
      if (status.status === "unknown") {
        instance = null;
        status = null;
      }
    } catch {
      instance = null;
      status = null;
    }
  }
  if (instance === null) {
    try {
      instance = await workflow.create({
        id: request.workflow_instance_id,
        params: createParams,
      });
    } catch {
      instance = await workflow.get(request.workflow_instance_id);
    }
  }
  status ??= await instance.status();
  if (status.status === "paused") {
    try {
      await instance.resume();
    } catch {
      // A concurrent replay may already have resumed the exact instance.
    }
    status = await instance.status();
  }
  if (status.status === "errored" || status.status === "terminated") {
    return {
      contract: "card-keepr-reconciliation-workflow@1",
      ingestion_run_id: request.ingestion_run_id,
      expected_current_revision_id: request.expected_current_revision_id,
      idempotency_key: request.idempotency_key,
      workflow_instance_id: request.workflow_instance_id,
      status: "complete",
      output: await recoverTerminalWorkflow(
        database,
        request,
        status.error?.message ?? `The reconciliation Workflow became ${status.status}.`,
      ),
    };
  }
  const output = status.status === "complete" ? await workflowOutput(database, request, status.output) : null;
  return {
    contract: "card-keepr-reconciliation-workflow@1",
    ingestion_run_id: request.ingestion_run_id,
    expected_current_revision_id: request.expected_current_revision_id,
    idempotency_key: request.idempotency_key,
    workflow_instance_id: request.workflow_instance_id,
    status: status.status,
    output,
  };
}

async function recoverTerminalWorkflow(
  database: D1Database,
  request: ReconciliationWorkflowRequestRow,
  detail: string,
): Promise<Record<string, unknown>> {
  const run = await database
    .prepare(
      `SELECT candidate_digest
       FROM ingestion_runs
       WHERE id = ?`,
    )
    .bind(request.ingestion_run_id)
    .first<{ candidate_digest: string | null }>();
  if (run === null) {
    throw new Error("The reconciliation Workflow run is unavailable.");
  }
  if (run.candidate_digest !== null) {
    return retainedReconciliationResult(database, request.ingestion_run_id);
  }
  return failReconciliationWorkflow(database, request.ingestion_run_id, request.observed_at, detail);
}

async function workflowOutput(
  database: D1Database,
  request: ReconciliationWorkflowRequestRow,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("result_json" in value) ||
    typeof value.result_json !== "string"
  ) {
    return recoverMalformedCompleteWorkflow(database, request);
  }
  let reference: unknown;
  try {
    reference = JSON.parse(value.result_json) as unknown;
  } catch {
    return recoverMalformedCompleteWorkflow(database, request);
  }
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
    return recoverMalformedCompleteWorkflow(database, request);
  }
  const result = reference as Record<string, unknown>;
  if (result.contract !== "card-keepr-reconciliation-workflow-result@1") {
    return recoverMalformedCompleteWorkflow(database, request);
  }
  if (result.run_id !== request.ingestion_run_id) {
    throw new Error("The reconciliation Workflow result is invalid.");
  }
  if (result.result !== null && typeof result.result === "object" && !Array.isArray(result.result)) {
    const retained = await retainedReconciliationResult(database, request.ingestion_run_id);
    if (canonicalJson(retained) !== canonicalJson(result.result as Record<string, unknown>)) {
      throw new Error("The reconciliation Workflow result does not bind the retained reconciliation.");
    }
    return retained;
  }
  if (typeof result.candidate_digest !== "string") {
    return recoverMalformedCompleteWorkflow(database, request);
  }
  const retained = await retainedReconciliationResult(database, request.ingestion_run_id);
  if (retained.candidate_digest !== result.candidate_digest) {
    throw new Error("The reconciliation Workflow result does not bind the retained candidate.");
  }
  return retained;
}

function recoverMalformedCompleteWorkflow(
  database: D1Database,
  request: ReconciliationWorkflowRequestRow,
): Promise<Record<string, unknown>> {
  return recoverTerminalWorkflow(database, request, "The completed reconciliation Workflow output was unavailable.");
}

async function workflowRequest(
  database: D1Database,
  idempotencyKey: string,
): Promise<ReconciliationWorkflowRequestRow | null> {
  return database
    .prepare(
      `SELECT idempotency_key, ingestion_run_id,
              expected_current_revision_id, request_json,
              workflow_params_json, workflow_instance_id, observed_at
       FROM reconciliation_workflow_requests
       WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<ReconciliationWorkflowRequestRow>();
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

function assertExactReplay(stored: ReconciliationWorkflowRequestRow, requestJson: string): void {
  if (stored.request_json !== requestJson) {
    throw new AdministrationProblem(
      409,
      "idempotency_conflict",
      "The reconciliation idempotency key is already bound to another request.",
    );
  }
}
