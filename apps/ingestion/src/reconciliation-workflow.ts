import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  pauseFailedReconciliation,
  initializeReconciliationProgress,
  type ReconciliationWorkflowParams,
  reconcileRetainedCardPrintingEvidence,
} from "../../../src/catalogue/reconciliation";
import { canonicalJson, catalogueStore, workflowSteps } from "../../../src/catalogue/shared";
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
  await initializeReconciliationProgress(
    catalogueStore(env.CATALOGUE_DB),
    event.payload.ingestion_run_id,
    event.payload.observed_at,
  );
  let reconciliationResultJson: string;
  try {
    reconciliationResultJson = await runReconciliationWorkUnits(env, step, event.payload);
  } catch (error) {
    reconciliationResultJson = await step.do(workflowSteps.reconciliation.failure, reconciliationStep, async () => {
      const result = await pauseFailedReconciliation(
        catalogueStore(env.CATALOGUE_DB),
        event.payload.ingestion_run_id,
        event.payload.generation ?? 0,
        error instanceof Error ? error.message : "The reconciliation Workflow exhausted its retries.",
      );
      return durableReconciliationResult(event.payload.ingestion_run_id, result);
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
  params: Pick<ReconciliationWorkflowParams, "ingestion_run_id" | "observed_at" | "generation">,
  stepName: string = workflowSteps.reconciliation.reconcile,
): Promise<string> {
  for (let unit = 0; ; unit++) {
    const resultJson = await step.do(
      unit === 0 ? stepName : `${stepName}-unit-${unit}`,
      reconciliationStep,
      async () => {
        const result = await reconcileRetainedCardPrintingEvidence(
          catalogueStore(env.CATALOGUE_DB),
          env.EVIDENCE_OBJECTS,
          params.ingestion_run_id,
          params.observed_at,
          env.PRINTING_IMAGES,
          params.generation ?? 0,
          true,
        );
        return result.continuation !== undefined
          ? JSON.stringify({ continuation: result.continuation })
          : durableReconciliationResult(params.ingestion_run_id, result);
      },
    );
    if ((JSON.parse(resultJson) as { continuation?: unknown }).continuation !== undefined) continue;
    return resultJson;
  }
}

export function durableReconciliationResult(runId: string, result: Record<string, unknown>): string {
  const reference = canonicalJson(
    typeof result.candidate_digest === "string"
      ? {
          contract: "card-keepr-reconciliation-workflow-result@1",
          run_id: runId,
          candidate_digest: result.candidate_digest,
        }
      : {
          contract: "card-keepr-reconciliation-workflow-result@1",
          run_id: runId,
          result,
        },
  );
  if (new TextEncoder().encode(reference).byteLength >= 524_288) {
    throw new Error("The reconciliation Workflow result exceeds its 512 KiB bound.");
  }
  return reference;
}
