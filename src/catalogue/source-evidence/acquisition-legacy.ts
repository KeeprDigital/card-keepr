import { createHash } from "node:crypto";
import { AdministrationProblem, type CatalogueStore, isWorkflowInstanceNotFound, workflowDriver } from "../shared";
import {
  acquisitionInitializationGuard,
  acquisitionLegacyEvent,
  acquisitionLegacyRawKeys,
  acquisitionLegacyWorkflows,
} from "./acquisition-budget-repository";
import type { EvidenceHostWorkflowParams, EvidenceParentWorkflowParams } from "./source-evidence-model";

export type LegacyAcquisitionContext = {
  evidenceObjects: R2Bucket;
  parentWorkflow: Workflow<EvidenceParentWorkflowParams>;
  hostWorkflow: Workflow<EvidenceHostWorkflowParams>;
};

/** Read-only qualification; the caller repeats the state/ownership guard in its
 * initialization transaction. A missing control-plane response is never proof. */
export async function verifyLegacyAcquisition(db: CatalogueStore, runId: string, context: LegacyAcquisitionContext) {
  try {
    await acquisitionInitializationGuard(db, runId).first();
    const event = await acquisitionLegacyEvent(db, runId).first<{ last_event_id: string }>();
    if (event === null) throw new Error("Missing legacy run");
    let workflowAfter = "";
    for (;;) {
      const workflows = (await acquisitionLegacyWorkflows(db, runId, workflowAfter).all<{ id: string; kind: string }>())
        .results;
      if (!workflows.length) break;
      for (const workflow of workflows) {
        try {
          const binding = workflow.kind === "parent" ? context.parentWorkflow : context.hostWorkflow;
          const status = (await workflowDriver(binding).inspect(workflow.id)).status;
          if (!["complete", "errored", "terminated"].includes(status))
            throw new Error("Legacy Workflow still owns work");
        } catch (error) {
          if (!isWorkflowInstanceNotFound(error)) throw error;
        }
        workflowAfter = workflow.id;
      }
    }
    let after = "";
    let baseline = 0;
    for (;;) {
      const keys = (
        await acquisitionLegacyRawKeys(db, runId, after).all<{
          object_key: string;
          digest: string;
          maximum_digest: string;
          byte_length: number;
          maximum_byte_length: number;
        }>()
      ).results;
      if (!keys.length) break;
      for (const key of keys) {
        if (key.digest !== key.maximum_digest || key.byte_length !== key.maximum_byte_length || !key.digest)
          throw new Error("Conflicting retained raw-source receipts");
        const object = await context.evidenceObjects.get(key.object_key);
        if (object === null) throw new Error("Retained raw-source body is missing");
        const hash = createHash("sha256");
        let bytes = 0;
        const reader = object.body.getReader();
        for (;;) {
          const read = await reader.read();
          if (read.done) break;
          bytes += read.value.byteLength;
          if (bytes > key.byte_length) {
            await reader.cancel();
            throw new Error("Retained raw-source length changed");
          }
          hash.update(read.value);
        }
        if (bytes !== key.byte_length || hash.digest("hex") !== key.digest)
          throw new Error("Retained raw-source digest changed");
        baseline += bytes;
        if (!Number.isSafeInteger(baseline)) throw new Error("Raw-source baseline exceeds safe accounting range");
        after = key.object_key;
      }
    }
    return { baseline, eventId: event.last_event_id };
  } catch {
    throw new AdministrationProblem(
      409,
      "acquisition_initialization_not_quiescent",
      "Legacy initialization requires settled Workflow, transport and write ownership plus verified retained raw-source bodies.",
    );
  }
}
