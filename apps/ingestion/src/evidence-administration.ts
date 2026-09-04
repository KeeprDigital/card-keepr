import { AdministrationProblem } from "../../../src/catalogue/shared";
import type {
  EvidenceParentWorkflowParams,
  EvidenceHostWorkflowParams,
} from "../../../src/catalogue/source-evidence-model";
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
  currentCollectionWorkflowIds,
  pauseEvidenceRunForWorkflowRecovery,
  pauseEvidenceRunOnOwnerRequest,
  releaseTerminatedEvidenceRun,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
  terminateEvidenceRun,
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
  const classification =
    acquired !== null && acquired.created
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
  await database.batch(workflowAttemptStatements(database, runId, [workflowId]));
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

// Pause a collecting Ingestion Run on the owner's request. The run moves into
// its Workflow Pause with the reason 'owner_requested' under the same
// compare-and-set fence as a recovery pause, so every durable collection step
// that re-reads the run stops on its own; the parent and hostname-shard
// attempts that were current at the pause are then terminated best-effort to
// cut short any in-flight sleep. A replayed request returns the retained
// response and re-runs no fence, because the run may since have resumed
// under a new Workflow Attempt that must keep driving collection.
export async function pauseEvidenceCollection(
  database: D1Database,
  parentWorkflow: Workflow<EvidenceParentWorkflowParams>,
  hostWorkflow: Workflow<EvidenceHostWorkflowParams>,
  runId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  let run = await requiredEvidenceRun(database, runId);
  if (run.state === "collecting" && run.parent_workflow_id === null) {
    // A first attempt that has not bound its identity yet is bound before
    // the pause, exactly as resume does, so the pause record names the
    // attempt it abandons and the fence has an identity to compare against.
    await database
      .prepare(
        `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
         WHERE ingestion_run_id = ? AND parent_workflow_id IS NULL`,
      )
      .bind(parentWorkflowAttemptId(runId, 1), runId)
      .run();
    run = await requiredEvidenceRun(database, runId);
  }
  const workflowId = run.parent_workflow_id ?? parentWorkflowAttemptId(runId, 1);
  const [status, progress, current] = await Promise.all([
    observeWorkflowStatus(parentWorkflow, workflowId),
    collectionProgressFacts(database, runId),
    currentCollectionWorkflowIds(database, runId),
  ]);
  const outcome = await pauseEvidenceRunOnOwnerRequest(database, runId, {
    idempotency_key: idempotencyKey,
    workflow_instance_id: workflowId,
    workflow_status: status,
    last_progress_at: progress.last_progress_at,
  });
  if (outcome.applied) {
    await Promise.all([
      terminateWorkflowInstance(parentWorkflow, workflowId),
      ...current.child.map((id) => terminateWorkflowInstance(hostWorkflow, id)),
    ]);
  }
  return outcome.document;
}

// The safe status of one parent instance; an absent or unreachable instance
// reports as unavailable rather than failing the owner's request.
async function observeWorkflowStatus(
  workflow: Workflow<EvidenceParentWorkflowParams>,
  instanceId: string,
): Promise<SafeWorkflowStatus> {
  try {
    const instance = await workflow.get(instanceId);
    return safeWorkflowStatus((await instance.status()).status);
  } catch {
    return "unavailable";
  }
}

// Terminate a paused Ingestion Run deliberately. The compare-and-set
// transition to the terminal owner-termination state is itself the fence for
// every durable collection step, because each step re-reads the run before
// acting; terminating the current parent and hostname-shard Workflow
// Attempts then stops any in-flight sleep or step as well. Only after both
// fences is the single active-run reservation released, so no successor run
// can start while late collection work could still act. Every step is
// idempotent, so a replayed termination re-runs the fences harmlessly and
// returns the original result.
export async function terminateEvidenceCollection(
  database: D1Database,
  parentWorkflow: Workflow<EvidenceParentWorkflowParams>,
  hostWorkflow: Workflow<EvidenceHostWorkflowParams>,
  runId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  await pauseCollectingRunWithDeadWorkflow(database, parentWorkflow, runId);
  const document = await terminateEvidenceRun(database, runId, {
    idempotency_key: idempotencyKey,
  });
  const current = await currentCollectionWorkflowIds(database, runId);
  await Promise.all([
    ...current.parent.map((id) => terminateWorkflowInstance(parentWorkflow, id)),
    ...current.child.map((id) => terminateWorkflowInstance(hostWorkflow, id)),
  ]);
  // The release outcome is observed, never assumed: a replay re-runs the
  // fences and reports the reservation's actual state.
  const activeRunReleased = await releaseTerminatedEvidenceRun(database, runId);
  return { ...document, active_run_released: activeRunReleased };
}

// Collection Termination is the only path from paused to terminal, and a
// Workflow Pause is otherwise recorded only on the resume path, which
// immediately reopens collection. A collecting run whose bound parent
// Workflow is deterministically observed dead (stalled, errored, terminated,
// or unavailable) is therefore moved into its Workflow Pause here first, so
// the owner can abandon it without resuming it. A live parent leaves the run
// collecting and the termination is refused as before.
async function pauseCollectingRunWithDeadWorkflow(
  database: D1Database,
  parentWorkflow: Workflow<EvidenceParentWorkflowParams>,
  runId: string,
): Promise<void> {
  const run = await requiredEvidenceRun(database, runId);
  if (run.state !== "collecting" || run.parent_workflow_id === null) return;
  const status = await observeWorkflowStatus(parentWorkflow, run.parent_workflow_id);
  const progress = await collectionProgressFacts(database, runId);
  const classification = classifyCollectionProgress(status, progress);
  if (classification.kind !== "recover") return;
  await pauseEvidenceRunForWorkflowRecovery(database, runId, {
    workflow_instance_id: run.parent_workflow_id,
    pause_reason: classification.reason,
    workflow_status: status,
    last_progress_at: progress.last_progress_at,
  });
}

// Best effort: a settled, absent, or unreachable instance rejects
// termination, and the database fence already stops its late work.
async function terminateWorkflowInstance(
  workflow: Workflow<EvidenceParentWorkflowParams | EvidenceHostWorkflowParams>,
  instanceId: string,
): Promise<void> {
  try {
    const instance = await workflow.get(instanceId);
    await instance.terminate();
  } catch {
    // Already settled or unavailable.
  }
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
    acquired: await acquireParentWorkflow(workflow, resumed.parent_workflow_id, runId),
    recovery: {
      reason,
      superseded_workflow_id: supersededWorkflowId,
      workflow_status: superseded?.status ?? "unavailable",
      last_progress_at: progress.last_progress_at,
    },
  };
}
