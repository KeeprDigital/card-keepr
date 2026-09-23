// Deterministic classification of an Ingestion Run's collection Workflow.
// A Workflow Pause must never mistake legitimate durable waiting for a stall:
// classification consumes only persisted lifecycle evidence (last-progress
// time, host pacing deadlines, scheduled Retry-After deadlines) and the
// platform-reported Workflow status, mapped onto a closed safe vocabulary.

export type SafeWorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waiting_for_pause"
  | "unknown"
  | "unavailable";

export type WorkflowPauseReason =
  | "source_workflow_stalled"
  | "source_workflow_errored"
  | "source_workflow_terminated"
  | "source_workflow_unavailable"
  // The two reasons the parent's completion barrier records about itself
  // before it stops driving collection (#445). Both leave the retained
  // collection work valid and resume into a new Workflow Attempt.
  | "source_collection_no_progress"
  | "source_workflow_attempt_exhausted";

// The owner's deliberate pause of a collecting run is recorded as a Workflow
// Pause too: it abandons the current parent Workflow Attempt exactly like a
// classified recovery does, but its reason is the owner's decision, never a
// classification of the Workflow's health.
export const ownerRequestedPauseReason = "owner_requested";

export type RecordedWorkflowPauseReason = WorkflowPauseReason | typeof ownerRequestedPauseReason;

export type CollectionWorkflowFacts = Readonly<{
  now_ms: number;
  workflow_status: SafeWorkflowStatus;
  last_progress_ms: number | null;
  pacing_deadline_ms: number | null;
  retry_deadline_ms: number | null;
}>;

export type CollectionWorkflowClassification =
  { kind: "active" } | { kind: "instance_paused" } | { kind: "recover"; reason: WorkflowPauseReason };

// The longest legitimate silence between persisted lifecycle events while a
// running collection Workflow is healthy: one transport step may spend its
// four executions of up to ten minutes each plus bounded backoff without
// touching D1, and the parent barrier polls at most once a minute. Pacing
// and Retry-After waits are excluded from this window through their own
// persisted deadlines, so the grace period only has to cover in-flight step
// work, not deliberate sleeps.
export const collectionStallGraceMilliseconds = 45 * 60_000;

const platformStatuses: Record<string, SafeWorkflowStatus> = {
  queued: "queued",
  running: "running",
  paused: "paused",
  errored: "errored",
  terminated: "terminated",
  complete: "complete",
  waiting: "waiting",
  waitingForPause: "waiting_for_pause",
  waiting_for_pause: "waiting_for_pause",
  unknown: "unknown",
};

// Any status outside the closed platform vocabulary — including a thrown
// lookup represented by the caller as undefined — reports as 'unavailable'
// rather than echoing unvetted text into owner-facing documents.
export function safeWorkflowStatus(value: unknown): SafeWorkflowStatus {
  return typeof value === "string" ? (platformStatuses[value] ?? "unavailable") : "unavailable";
}

export function classifyCollectionWorkflow(facts: CollectionWorkflowFacts): CollectionWorkflowClassification {
  switch (facts.workflow_status) {
    case "errored":
      return { kind: "recover", reason: "source_workflow_errored" };
    case "terminated":
      return { kind: "recover", reason: "source_workflow_terminated" };
    case "unknown":
    case "unavailable":
      return { kind: "recover", reason: "source_workflow_unavailable" };
    case "complete":
      // A parent that completed while the run still collects has
      // deterministically stopped driving it, regardless of elapsed time.
      return { kind: "recover", reason: "source_workflow_stalled" };
    case "paused":
      // A paused Workflow instance is the platform's own condition, distinct
      // from a paused Ingestion Run: the instance resumes in place.
      return { kind: "instance_paused" };
    case "queued":
    case "running":
    case "waiting":
    case "waiting_for_pause": {
      const waitUntil = Math.max(
        facts.last_progress_ms ?? Number.NEGATIVE_INFINITY,
        facts.pacing_deadline_ms ?? Number.NEGATIVE_INFINITY,
        facts.retry_deadline_ms ?? Number.NEGATIVE_INFINITY,
      );
      return facts.now_ms <= waitUntil + collectionStallGraceMilliseconds
        ? { kind: "active" }
        : { kind: "recover", reason: "source_workflow_stalled" };
    }
  }
}

export type CollectionProgressFacts = {
  last_progress_at: string | null;
  pacing_deadline_at: string | null;
  retry_deadline_at: string | null;
};

// Classify directly from the persisted progress facts' ISO timestamps.
export function classifyCollectionProgress(
  workflowStatus: SafeWorkflowStatus,
  progress: CollectionProgressFacts,
  nowMs: number = Date.now(),
): CollectionWorkflowClassification {
  return classifyCollectionWorkflow({
    now_ms: nowMs,
    workflow_status: workflowStatus,
    last_progress_ms: parseProgressTime(progress.last_progress_at),
    pacing_deadline_ms: parseProgressTime(progress.pacing_deadline_at),
    retry_deadline_ms: parseProgressTime(progress.retry_deadline_at),
  });
}

function parseProgressTime(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Parent Workflow Attempt identities advance the immutable parent-attempt
// sequence: attempt 1 is the original identity and
// each recovery appends '-resume-N'. Child hostname-shard attempts append
// '-attempt-N' to their digest base identity (see evidence-workflows.ts).
export function parentWorkflowAttemptId(runId: string, attemptNumber: number): string {
  return attemptNumber === 1 ? `evidence-${runId}` : `evidence-${runId}-resume-${attemptNumber - 1}`;
}

export function parentAttemptNumber(runId: string, instanceId: string): number | null {
  const baseId = `evidence-${runId}`;
  if (instanceId === baseId) return 1;
  const suffix = instanceId.startsWith(`${baseId}-resume-`) ? instanceId.slice(`${baseId}-resume-`.length) : null;
  return suffix !== null && /^[1-9]\d*$/u.test(suffix) ? Number.parseInt(suffix, 10) + 1 : null;
}

/**
 * Why a hostname shard was dispatched again under a successor identity.
 *
 * A `replacement` pays for recovery: the previous instance did not finish
 * normally (it errored, was terminated, is absent, or was inherited from a
 * superseded parent), so the shard's bounded replacement budget is spent.
 *
 * A `continuation` pays for nothing: the previous instance finished normally
 * after draining every pending Source Request in its sequence window, and the
 * shard is dispatched again only because later discovery admitted new requests
 * into that same window. A Workflow instance identity is single-use, so a
 * continuation still needs a fresh identity, but treating it as recovery
 * exhausted the budget of a healthy shard and failed its Source Requests
 * without ever attempting a fetch (#445).
 */
export type ChildWorkflowSuccession = "replacement" | "continuation";

const childSuccessorSuffix: Record<ChildWorkflowSuccession, string> = {
  replacement: "attempt",
  continuation: "continue",
};
// Both kinds share one zero-based successor sequence, so a shard's append-only
// attempt history stays a single ordered line whichever kind each successor is.
const childSuccessorPattern = /-(attempt|continue)-(0|[1-9]\d*)$/u;

export function childWorkflowSuccessorId(
  baseWorkflowId: string,
  successorIndex: number,
  succession: ChildWorkflowSuccession,
): string {
  return `${baseWorkflowId}-${childSuccessorSuffix[succession]}-${successorIndex}`;
}

/** The successor kind an identity declares, or null for a shard's base identity. */
export function childWorkflowSuccession(instanceId: string): ChildWorkflowSuccession | null {
  const suffix = instanceId.match(childSuccessorPattern);
  if (suffix === null) return null;
  return suffix[1] === childSuccessorSuffix.continuation ? "continuation" : "replacement";
}

export type WorkflowAttemptRecord = Readonly<{
  workflow_kind: "parent" | "child";
  base_workflow_id: string;
  attempt_number: number;
  workflow_instance_id: string;
}>;

// Derive the append-only attempt record for one Workflow instance identity.
// Identities are self-describing, so the same record is recomputed wherever
// the identity is observed and INSERT OR IGNORE keeps the history idempotent.
export function workflowAttemptRecord(runId: string, instanceId: string): WorkflowAttemptRecord {
  const parentAttempt = parentAttemptNumber(runId, instanceId);
  if (parentAttempt !== null) {
    return {
      workflow_kind: "parent",
      base_workflow_id: `evidence-${runId}`,
      attempt_number: parentAttempt,
      workflow_instance_id: instanceId,
    };
  }
  const childSuffix = instanceId.match(childSuccessorPattern);
  return childSuffix === null
    ? {
        workflow_kind: "child",
        base_workflow_id: instanceId,
        attempt_number: 1,
        workflow_instance_id: instanceId,
      }
    : {
        workflow_kind: "child",
        base_workflow_id: instanceId.slice(0, -childSuffix[0].length),
        // Child successor suffixes are zero-based (see
        // nextChildWorkflowIdentity in evidence-workflows.ts): the bare digest
        // identity is attempt 1 and successor 0 is the first successor, so
        // suffix N maps to attempt N + 2 whichever succession it declares.
        attempt_number: Number.parseInt(childSuffix[2]!, 10) + 2,
        workflow_instance_id: instanceId,
      };
}

/**
 * The parent's completion-barrier poll interval. Deep multi-shard collections
 * poll once a minute. Otherwise the interval starts at one second and doubles
 * for every consecutive poll that finds the same pending shard set, up to a
 * minute, so a single long shard (an archive parse) costs a bounded number of
 * polls, steps and subrequests instead of one per second (#327). A changed
 * shard set resets it. Inputs are durable step results, so replay derives the
 * same durations. "immediate" is the test harness wait mode.
 */
export function collectionBarrierWaitMilliseconds(input: {
  maximumShardDepth: number;
  maximumActiveRequestCount: number;
  unchangedPolls: number;
  mode: "production" | "immediate";
}): number {
  if (input.mode === "immediate") return 1000;
  if (input.maximumShardDepth > 1 && input.maximumActiveRequestCount > 10) return 60_000;
  return Math.min(60_000, 1000 * 2 ** Math.min(input.unchangedPolls, 6));
}

/**
 * Barrier polls one parent Workflow Attempt may run before it hands the run
 * back to the owner.
 *
 * Cloudflare ends a Workflow instance that reaches 10,000 durable steps, and
 * the ending is an engine error the instance cannot observe or record: the
 * #445 parent died at `finalize collection barrier stage 3288` with 2,457
 * Source Requests still pending, and because nothing was recorded the run sat
 * in `collecting` with an idle runtime and no owner signal. A poll costs at
 * most five durable steps (shards, recovery, identity summary, finalize and
 * the wait), so this ceiling keeps an attempt near 7,500 steps and leaves the
 * remaining budget for the preamble, invocation yields and the step in flight.
 * Reaching it is not a failure: the attempt is exhausted, not the run.
 */
export const collectionBarrierPollCeiling = 1500;

/**
 * The silence the barrier tolerates before it declares its own collection
 * stalled. Production reuses the stall grace the owner-facing classification
 * uses, so one definition of "legitimately quiet" governs both. Test runtimes
 * run with "immediate" waits and need a bound they can reach.
 */
export function collectionNoProgressGraceMilliseconds(mode: "production" | "immediate"): number {
  return mode === "immediate" ? 60_000 : collectionStallGraceMilliseconds;
}

export type CollectionBarrierHalt = Readonly<{
  reason: "source_collection_no_progress" | "source_workflow_attempt_exhausted";
}>;

/**
 * Decide whether the parent's completion barrier may poll again.
 *
 * Every input is derived from durable step results, so a replay reaches the
 * same verdict. `quietSinceMs` is the most recent moment the run was observed
 * moving: a change in its Source Request census, or work recorded by a current
 * hostname-shard Workflow Attempt. A run with no active Source Request is
 * never stalled — the barrier is simply waiting for finalization.
 */
export function classifyCollectionBarrier(input: {
  barrierStage: number;
  activeRequestCount: number;
  observedAtMs: number;
  quietSinceMs: number;
  mode: "production" | "immediate";
}): CollectionBarrierHalt | null {
  if (input.barrierStage >= collectionBarrierPollCeiling) {
    return { reason: "source_workflow_attempt_exhausted" };
  }
  if (input.activeRequestCount < 1) return null;
  return input.observedAtMs - input.quietSinceMs > collectionNoProgressGraceMilliseconds(input.mode)
    ? { reason: "source_collection_no_progress" }
    : null;
}
