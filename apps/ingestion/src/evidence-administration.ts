import { AdministrationProblem } from "../../../src/catalogue/ingestion";
import type { EvidenceParentWorkflowParams } from "../../../src/catalogue/source-evidence-model";
import { requiredEvidenceRun } from "../../../src/catalogue/source-evidence-repository";

export async function resumeEvidenceRun(
  database: D1Database,
  workflow: Workflow<EvidenceParentWorkflowParams>,
  runId: string,
): Promise<Record<string, unknown>> {
  const run = await requiredEvidenceRun(database, runId);
  if (run.state !== "collecting") {
    throw new AdministrationProblem(
      409,
      "ingestion_run_not_collecting",
      "Only an Ingestion Run in its collection phase can be resumed.",
    );
  }
  const workflowId = `evidence-${runId}`;
  let instance: WorkflowInstance;
  let status: Record<string, unknown> = { status: "queued" };
  if (run.parent_workflow_id === null) {
    try {
      instance = await workflow.create({
        id: workflowId,
        params: { ingestion_run_id: runId },
      });
    } catch {
      instance = await workflow.get(workflowId);
    }
    await database
      .prepare(
        `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
         WHERE ingestion_run_id = ? AND parent_workflow_id IS NULL`,
      )
      .bind(workflowId, runId)
      .run();
  } else {
    instance = await workflow.get(run.parent_workflow_id);
    try {
      status = await instance.status();
      if (status.status === "errored" || status.status === "terminated") {
        await instance.restart();
        status = { status: "queued" };
      } else if (status.status === "paused") {
        await instance.resume();
        status = { status: "queued" };
      } else if (status.status === "complete") {
        await instance.restart({
          from: { name: "start dynamically sharded hostname workflows" },
        });
        status = { status: "queued" };
      }
    } catch {
      status = { status: "queued" };
    }
  }
  const result = {
    ingestion_run_id: runId,
    workflow: {
      id: instance.id,
      ...status,
    },
  };
  return result;
}
