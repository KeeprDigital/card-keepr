import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  pauseFailedReconciliation,
  initializeReconciliationProgress,
  type ReconciliationWorkflowParams,
  reconcileRetainedCardPrintingEvidence,
  retainReconciliationDispatch,
  reconciliationDispatchState,
} from "../../../src/catalogue/reconciliation";
import { canonicalJson, catalogueStore, workflowDriver, workflowSteps } from "../../../src/catalogue/shared";
import { observeOperationalWorkflow } from "../../../src/http/operational-log";

const reconciliationStep = {
  retries: { limit: 3, delay: 250, backoff: "exponential" as const },
  timeout: "10 minutes" as const,
};

export class ReconciliationWorkflow extends WorkflowEntrypoint<Env, ReconciliationWorkflowParams> {
  override run(
    event: Readonly<WorkflowEvent<ReconciliationWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ result_json: string }> {
    return runReconciliationWorkflow(this.env, event, step);
  }
}

export async function runReconciliationWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<ReconciliationWorkflowParams>>,
  step: WorkflowStep,
): Promise<{ result_json: string }> {
  ({ env, step } = observeOperationalWorkflow(step, event, env));
  let reconciliationResultJson: string;
  try {
    await step.do(workflowSteps.reconciliation.initialize, reconciliationStep, async () => {
      await initializeReconciliationProgress(
        catalogueStore(env.CATALOGUE_DB),
        event.payload.preparation_id ?? event.payload.ingestion_run_id,
        event.payload.observed_at,
      );
      return JSON.stringify({ initialized: true });
    });
    reconciliationResultJson = await runReconciliationWorkUnits(
      env,
      step,
      event.payload,
      workflowSteps.reconciliation.reconcile,
      event.payload.shard?.root ?? { binding: "reconciliation", id: event.instanceId },
    );
  } catch (error) {
    reconciliationResultJson = await step.do(workflowSteps.reconciliation.failure, reconciliationStep, async () => {
      const result = await pauseFailedReconciliation(
        catalogueStore(env.CATALOGUE_DB),
        event.payload.preparation_id ?? event.payload.ingestion_run_id,
        event.payload.generation ?? 0,
        error instanceof Error ? error.message : "The reconciliation Workflow exhausted its retries.",
      );
      return durableReconciliationResult(event.payload.ingestion_run_id, result, event.payload.preparation_id);
    });
  }
  if (event.payload.shard && JSON.parse(reconciliationResultJson).continuation === undefined) {
    const root = event.payload.shard.root;
    await step.do(workflowSteps.reconciliation.notifyRoot, reconciliationStep, async () => {
      const binding = root.binding === "collection" ? env.EVIDENCE_INGESTION_WORKFLOW : env.RECONCILIATION_WORKFLOW;
      await (await binding.get(root.id)).sendEvent({
        type: "reconciliation-terminal",
        payload: reconciliationResultJson,
      });
      return JSON.stringify({ delivered: true });
    });
  }
  return {
    result_json: reconciliationResultJson,
  };
}

/** Each successful callback returns either the next durable cursor or the terminal reference. */
export async function runReconciliationWorkUnits(
  env: Env,
  step: WorkflowStep,
  params: ReconciliationWorkflowParams,
  stepName: string = workflowSteps.reconciliation.reconcile,
  root: NonNullable<ReconciliationWorkflowParams["shard"]>["root"],
): Promise<string> {
  const state = JSON.parse(
    await step.do(workflowSteps.reconciliation.dispatchState, reconciliationStep, async () =>
      JSON.stringify(await reconciliationDispatchState(catalogueStore(env.CATALOGUE_DB), params)),
    ),
  ) as Awaited<ReturnType<typeof reconciliationDispatchState>>;
  if (state.operation?.state === "sealed" && state.operation.candidate_digest)
    return durableReconciliationResult(
      params.ingestion_run_id,
      { candidate_digest: state.operation.candidate_digest },
      params.preparation_id,
    );
  if (
    state.successor &&
    state.operation?.state === "preparing" &&
    state.operation.generation === (params.generation ?? 0)
  ) {
    await dispatchSuccessor(env, step, state.successor.id, state.successor.params);
    return finishShard(step, params, state.successor.id, state.operation?.deadline);
  }
  // Ten work callbacks leave room for all four attempts at 100 service calls,
  // plus bounded dispatch/failure steps, inside the 5,000-call shard target.
  for (let unit = 0; unit < 10; unit++) {
    const ordinal = (params.shard?.ordinal ?? 0) * 10 + unit;
    const resultJson = await step.do(
      ordinal === 0 ? stepName : `${stepName}-unit-${ordinal}`,
      reconciliationStep,
      async () => {
        const result = await reconcileRetainedCardPrintingEvidence(
          catalogueStore(env.CATALOGUE_DB),
          env.EVIDENCE_OBJECTS,
          params.preparation_id ?? params.ingestion_run_id,
          params.observed_at,
          env.PRINTING_IMAGES,
          params.generation ?? 0,
          true,
        );
        return result.continuation !== undefined
          ? JSON.stringify({ continuation: result.continuation })
          : durableReconciliationResult(params.ingestion_run_id, result, params.preparation_id);
      },
    );
    if ((JSON.parse(resultJson) as { continuation?: unknown }).continuation !== undefined) continue;
    return resultJson;
  }
  const successor: ReconciliationWorkflowParams = {
    ...params,
    shard: { ordinal: (params.shard?.ordinal ?? 0) + 1, root },
  };
  const retained = await step.do(workflowSteps.reconciliation.retainSuccessor, reconciliationStep, async () =>
    JSON.stringify({ id: await retainReconciliationDispatch(catalogueStore(env.CATALOGUE_DB), successor) }),
  );
  const { id } = JSON.parse(retained) as { id: string };
  await dispatchSuccessor(env, step, id, successor);
  return finishShard(step, params, id, state.operation?.deadline);
}

async function dispatchSuccessor(env: Env, step: WorkflowStep, id: string, params: ReconciliationWorkflowParams) {
  await step.do(workflowSteps.reconciliation.dispatchSuccessor, reconciliationStep, async () => {
    await workflowDriver(env.RECONCILIATION_WORKFLOW).ensure(id, params, { createRequested: true });
    return JSON.stringify({ id });
  });
}

async function finishShard(step: WorkflowStep, params: ReconciliationWorkflowParams, id: string, deadline?: string) {
  if (params.shard) return JSON.stringify({ continuation: { workflow_instance_id: id } });
  const terminal = await step.waitForEvent<string>(workflowSteps.reconciliation.terminal, {
    type: "reconciliation-terminal",
    timeout: Math.max(
      1000,
      (deadline ? Date.parse(deadline) : Date.parse(params.observed_at) + 604800000) - Date.now(),
    ),
  });
  return terminal.payload;
}

export function durableReconciliationResult(
  runId: string,
  result: Record<string, unknown>,
  preparationId?: string,
): string {
  const identity = preparationId
    ? { contract: "card-keepr-game-reconciliation-workflow-result@1", run_id: runId, preparation_id: preparationId }
    : { contract: "card-keepr-reconciliation-workflow-result@1", run_id: runId };
  const reference = canonicalJson(
    typeof result.candidate_digest === "string"
      ? {
          ...identity,
          candidate_digest: result.candidate_digest,
        }
      : {
          ...identity,
          result,
        },
  );
  if (new TextEncoder().encode(reference).byteLength >= 524_288) {
    throw new Error("The reconciliation Workflow result exceeds its 512 KiB bound.");
  }
  return reference;
}
