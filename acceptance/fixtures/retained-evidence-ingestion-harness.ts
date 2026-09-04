import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { EvidenceParentWorkflowParams } from "../../src/catalogue/source-evidence";
import { EvidenceIngestionWorkflow as ProductionEvidenceIngestionWorkflow } from "../../apps/ingestion/src/index";

export {
  default,
  CatalogueBackupWorkflow,
  EvidenceHostWorkflow,
  OfficialSourceTransport,
  ReconciliationWorkflow,
} from "./contextual-legality-ingestion-harness";

export class EvidenceIngestionWorkflow extends ProductionEvidenceIngestionWorkflow {
  override async run(
    event: Readonly<WorkflowEvent<EvidenceParentWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const result = await super.run(event, step);
    if (typeof result === "object" && result !== null && "reconciliation" in result) {
      // Hold the parent open after reconciliation persists awaiting_approval.
      // Retained-document comparisons must wait for the Workflow to settle too.
      await step.do("hold parent completion for retained evidence audit", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return null;
      });
    }
    return result;
  }
}
