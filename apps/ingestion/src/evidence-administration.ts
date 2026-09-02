import { AdministrationProblem } from "../../../src/catalogue/ingestion";
import type { EvidenceParentWorkflowParams } from "../../../src/catalogue/source-evidence-model";
import {
  requiredEvidenceRun,
  resumePausedEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";

export async function resumeEvidenceRun(
  database: D1Database,
  workflow: Workflow<EvidenceParentWorkflowParams>,
  runId: string,
): Promise<Record<string, unknown>> {
  let run = await requiredEvidenceRun(database, runId);
  if (run.state === "paused") {
    // A paused run resumes under a parent Workflow identity derived from the
    // count of recorded resumes: the previous parent completed when the run
    // left its collection phase, and a deterministic new identity keeps
    // replayed resumes reacquiring the same instance. A still-captured
    // Source Request re-parses its retained Source Snapshot inside the
    // hostname shard without another Official Source fetch, and a
    // retry-exhausted request reopens under its next bounded retry
    // generation.
    await resumePausedEvidenceRun(database, runId);
    run = await requiredEvidenceRun(database, runId);
  }
  if (run.state !== "collecting") {
    throw new AdministrationProblem(
      409,
      "ingestion_run_not_collecting",
      "Only an Ingestion Run in its collection phase can be resumed.",
    );
  }
  const workflowId = run.parent_workflow_id ?? `evidence-${runId}`;
  let instance: WorkflowInstance;
  let status: Record<string, unknown> = { status: "queued" };
  try {
    instance = await workflow.get(workflowId);
  } catch {
    try {
      instance = await workflow.create({
        id: workflowId,
        params: { ingestion_run_id: runId },
      });
    } catch {
      instance = await workflow.get(workflowId);
    }
  }
  if (run.parent_workflow_id === null) {
    await database
      .prepare(
        `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
         WHERE ingestion_run_id = ? AND parent_workflow_id IS NULL`,
      )
      .bind(workflowId, runId)
      .run();
  }
  try {
    status = await instance.status();
    if (status.status === "errored" || status.status === "terminated") {
      await instance.restart();
      status = { status: "queued" };
    } else if (status.status === "paused") {
      await instance.resume();
      status = { status: "queued" };
    } else if (status.status === "complete") {
      // The parent completes cleanly when the run pauses mid-collection, so
      // a resume that reuses its identity must restart it from the top; the
      // barrier loop is deterministic over retained state. (A targeted
      // restart-from-step is not used: the step name it referenced no
      // longer exists, and restart() re-derives the same position.)
      await instance.restart();
      status = { status: "queued" };
    }
  } catch {
    status = { status: "queued" };
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
