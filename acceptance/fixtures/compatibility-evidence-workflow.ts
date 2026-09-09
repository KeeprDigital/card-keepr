import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { EvidenceIngestionWorkflow as ProductionEvidenceIngestionWorkflow } from "../../apps/ingestion/src/index";
import type { EvidenceParentWorkflowParams, requiredEvidenceRun } from "../../src/catalogue/source-evidence";

// Publication uses the explicit run-level compatibility contract pending #226–#228.
// Reuse the real parent capture/barrier and real reconciliation Workflows; only
// choose the retained compatibility preparation after collection completes.
export class EvidenceIngestionWorkflow extends ProductionEvidenceIngestionWorkflow {
  protected override prepareCollectedEvidence(
    event: Readonly<WorkflowEvent<EvidenceParentWorkflowParams>>,
    step: WorkflowStep,
    run: Awaited<ReturnType<typeof requiredEvidenceRun>>,
  ): Promise<unknown> {
    return this.reconcileCollectedEvidence(event, step, run);
  }
}
