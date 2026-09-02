import { AdministrationProblem } from "../../../src/catalogue/ingestion";
import type { EvidenceParentWorkflowParams } from "../../../src/catalogue/source-evidence-model";
import {
  classifyCollectionProgress,
  parentAttemptNumber,
  parentWorkflowAttemptId,
  safeWorkflowStatus,
  type CollectionProgressFacts,
  type SafeWorkflowStatus,
} from "../../../src/catalogue/collection-recovery";
import {
  collectionProgressFacts,
  pauseEvidenceRunForWorkflowRecovery,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
  workflowAttemptStatements,
  type IngestionEvidenceRow,
} from "../../../src/catalogue/source-evidence-repository";

type AcquiredParent = {
  instance: WorkflowInstance;
  status: SafeWorkflowStatus;
  created: boolean;
};

// Reacquire the parent Workflow instance for one deterministic attempt
// identity, creating it when the platform has no instance under that name. A
// null result means the identity is unavailable: it can be neither fetched
// nor created, which classification treats as a lost Workflow.
async function acquireParentWorkflow(
  workflow: Workflow<EvidenceParentWorkflowParams>,
  workflowId: string,
  runId: string,
): Promise<AcquiredParent | null> {
  let instance: WorkflowInstance;
  let created = false;
  try {
    instance = await workflow.get(workflowId);
  } catch {
    try {
      instance = await workflow.create({
        id: workflowId,
        params: { ingestion_run_id: runId },
      });
      created = true;
    } catch {
      try {
        instance = await workflow.get(workflowId);
      } catch {
        return null;
      }
    }
  }
  try {
    return {
      instance,
      status: safeWorkflowStatus((await instance.status()).status),
      created,
    };
  } catch {
    return { instance, status: "unknown", created };
  }
}

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
  let workflowId = run.parent_workflow_id ?? parentWorkflowAttemptId(runId, 1);
  let acquired = await acquireParentWorkflow(workflow, workflowId, runId);
  if (run.parent_workflow_id === null) {
    // Bind the first attempt's identity before any classification: the
    // recovery pause below is compare-and-set on the bound identity, so an
    // unbound run could otherwise never recover a first attempt that died
    // between creation and binding.
    await database
      .prepare(
        `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
         WHERE ingestion_run_id = ? AND parent_workflow_id IS NULL`,
      )
      .bind(workflowId, runId)
      .run();
  }
  const progress = await collectionProgressFacts(database, runId);
  let recovery: Record<string, unknown> | null = null;
  // A freshly created instance is the new current attempt by construction;
  // classification only judges an attempt that already existed, from its
  // platform status and the persisted progress evidence.
  const classification = acquired !== null && acquired.created
    ? { kind: "active" as const }
    : classifyCollectionProgress(acquired?.status ?? "unavailable", progress);
  if (classification.kind === "instance_paused" && acquired !== null) {
    // The Workflow instance's own paused status is a platform condition
    // distinct from a paused Ingestion Run: the same attempt resumes in
    // place.
    try {
      await acquired.instance.resume();
    } catch {
      // The status document below still reports the observed state.
    }
  } else if (classification.kind === "recover") {
    // A running-status attempt classified as stalled is superseded, so it
    // must not keep driving collection beside its replacement; termination
    // is best-effort because a genuinely dead instance rejects it.
    if (acquired !== null) {
      try {
        await acquired.instance.terminate();
      } catch {
        // Already dead or unavailable; recovery proceeds regardless.
      }
    }
    ({ run, workflowId, acquired, recovery } = await recoverParentWorkflow(
      database,
      workflow,
      run,
      workflowId,
      acquired,
      progress,
      classification.reason,
    ));
  }
  // The bound identity becomes (or replays) its append-only Workflow Attempt
  // record, so the very first parent attempt is retained exactly like every
  // recovery attempt.
  await database.batch(workflowAttemptStatements(database, runId, [
    workflowId,
  ]));
  return {
    ingestion_run_id: runId,
    workflow: {
      id: workflowId,
      attempt_number: parentAttemptNumber(runId, workflowId),
      status: acquired === null ? "unavailable" : acquired.status,
    },
    ...(recovery === null ? {} : { recovery }),
  };
}

// Pause the run with the Workflow Pause reason, then immediately reopen it
// through the ordinary paused-resume path: the append-only transition
// history records collecting -> paused -> collecting, and the deterministic
// resume identity opens the next parent Workflow Attempt without changing
// the Ingestion Run identity, its Source Requests, or any idempotent
// capture-operation identity. Concurrent recoveries converge on one new
// attempt because the identity binding is compare-and-set on the transition
// count that derived it.
async function recoverParentWorkflow(
  database: D1Database,
  workflow: Workflow<EvidenceParentWorkflowParams>,
  run: IngestionEvidenceRow,
  supersededWorkflowId: string,
  superseded: AcquiredParent | null,
  progress: CollectionProgressFacts,
  reason:
    | "source_workflow_stalled"
    | "source_workflow_errored"
    | "source_workflow_terminated"
    | "source_workflow_unavailable",
): Promise<{
  run: IngestionEvidenceRow;
  workflowId: string;
  acquired: AcquiredParent | null;
  recovery: Record<string, unknown>;
}> {
  const runId = run.id;
  await pauseEvidenceRunForWorkflowRecovery(database, runId, {
    workflow_instance_id: supersededWorkflowId,
    pause_reason: reason,
    workflow_status: superseded?.status ?? "unavailable",
    last_progress_at: progress.last_progress_at,
  });
  await resumePausedEvidenceRun(database, runId);
  const resumed = await requiredEvidenceRun(database, runId);
  if (resumed.state !== "collecting" || resumed.parent_workflow_id === null) {
    throw new AdministrationProblem(
      409,
      "ingestion_run_not_collecting",
      "Only an Ingestion Run in its collection phase can be resumed.",
    );
  }
  return {
    run: resumed,
    workflowId: resumed.parent_workflow_id,
    acquired: await acquireParentWorkflow(
      workflow,
      resumed.parent_workflow_id,
      runId,
    ),
    recovery: {
      reason,
      superseded_workflow_id: supersededWorkflowId,
      workflow_status: superseded?.status ?? "unavailable",
      last_progress_at: progress.last_progress_at,
    },
  };
}

