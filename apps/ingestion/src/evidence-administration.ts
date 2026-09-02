import { AdministrationProblem } from "../../../src/catalogue/ingestion";
import type { EvidenceParentWorkflowParams } from "../../../src/catalogue/source-evidence-model";
import {
  requiredEvidenceRun,
  resumeCapacityPausedEvidenceRun,
  runRequestCapacityPolicy,
} from "../../../src/catalogue/source-evidence-repository";

export async function resumeEvidenceRun(
  database: D1Database,
  workflow: Workflow<EvidenceParentWorkflowParams>,
  runId: string,
): Promise<Record<string, unknown>> {
  let run = await requiredEvidenceRun(database, runId);
  if (run.state === "paused") {
    // A capacity-paused run resumes under a parent Workflow identity derived
    // from its capacity generation: the previous parent completed when the
    // run left its collection phase, and a deterministic new identity keeps
    // replayed resumes reacquiring the same instance. The still-captured
    // parent Source Request re-parses its retained Source Snapshot inside
    // the hostname shard, deriving the overflow batch again without another
    // Official Source fetch.
    const policy = await runRequestCapacityPolicy(
      database,
      runId,
      run.adapter_version,
    );
    await resumeCapacityPausedEvidenceRun(
      database,
      runId,
      `evidence-${runId}-resume-${policy.capacity_generation}`,
    );
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
      await instance.restart({
        from: { name: "start dynamically sharded hostname workflows" },
      });
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
