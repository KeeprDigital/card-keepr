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
    reconciliationResultJson = await step.do(workflowSteps.reconciliation.reconcile, reconciliationStep, async () => {
      const result = await reconcileRetainedCardPrintingEvidence(
        catalogueStore(env.CATALOGUE_DB),
        env.EVIDENCE_OBJECTS,
        event.payload.ingestion_run_id,
        event.payload.observed_at,
        env.PRINTING_IMAGES,
        event.payload.generation ?? 0,
      );
      return durableReconciliationResult(event.payload.ingestion_run_id, result);
    });
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
