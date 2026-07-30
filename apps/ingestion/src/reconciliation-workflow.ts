import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  reconcileRetainedCardPrintingEvidence,
} from "../../../src/catalogue/card-printing-reconciliation";
import type {
  ReconciliationWorkflowParams,
} from "../../../src/catalogue/reconciliation-workflow";
import { canonicalJson } from "../../../src/catalogue/serialization";

const reconciliationStep = {
  retries: { limit: 3, delay: 250, backoff: "exponential" as const },
  timeout: "10 minutes" as const,
};

export class ReconciliationWorkflow extends WorkflowEntrypoint<
  Env,
  ReconciliationWorkflowParams
> {
  override run(
    event: Readonly<WorkflowEvent<ReconciliationWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ result_json: string }> {
    return step.do(
      "reconcile retained Card, Printing, and Erratum evidence",
      reconciliationStep,
      async () => {
        const result = await reconcileRetainedCardPrintingEvidence(
          this.env.CATALOGUE_DB,
          this.env.EVIDENCE_OBJECTS,
          event.payload.ingestion_run_id,
          event.payload.observed_at,
        );
        const durableResult = typeof result.candidate_digest === "string"
          ? {
            contract: "card-keepr-reconciliation-workflow-result@1",
            run_id: event.payload.ingestion_run_id,
            candidate_digest: result.candidate_digest,
          }
          : {
            contract: "card-keepr-reconciliation-workflow-result@1",
            run_id: event.payload.ingestion_run_id,
            result,
          };
        const resultJson = canonicalJson(durableResult);
        if (new TextEncoder().encode(resultJson).byteLength >= 524_288) {
          throw new Error(
            "The reconciliation Workflow result exceeds its 512 KiB bound.",
          );
        }
        return {
          result_json: resultJson,
        };
      },
    );
  }
}
