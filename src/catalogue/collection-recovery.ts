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
  | "source_workflow_unavailable";

export type CollectionWorkflowFacts = Readonly<{
  now_ms: number;
  workflow_status: SafeWorkflowStatus;
  last_progress_ms: number | null;
  pacing_deadline_ms: number | null;
  retry_deadline_ms: number | null;
}>;

export type CollectionWorkflowClassification =
  | { kind: "active" }
  | { kind: "instance_paused" }
  | { kind: "recover"; reason: WorkflowPauseReason };

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
  return typeof value === "string"
    ? platformStatuses[value] ?? "unavailable"
    : "unavailable";
}

export function classifyCollectionWorkflow(
  facts: CollectionWorkflowFacts,
): CollectionWorkflowClassification {
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
    default: {
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

// Parent Workflow Attempt identities are minted from the count of recorded
// paused -> collecting transitions: attempt 1 is the original identity and
// each recovery appends '-resume-N'. Child hostname-shard attempts append
// '-attempt-N' to their digest base identity (see evidence-workflows.ts).
export function parentWorkflowAttemptId(
  runId: string,
  attemptNumber: number,
): string {
  return attemptNumber === 1
    ? `evidence-${runId}`
    : `evidence-${runId}-resume-${attemptNumber - 1}`;
}

export function parentAttemptNumber(
  runId: string,
  instanceId: string,
): number | null {
  const baseId = `evidence-${runId}`;
  if (instanceId === baseId) return 1;
  const suffix = instanceId.startsWith(`${baseId}-resume-`)
    ? instanceId.slice(`${baseId}-resume-`.length)
    : null;
  return suffix !== null && /^[1-9]\d*$/u.test(suffix)
    ? Number.parseInt(suffix, 10) + 1
    : null;
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
export function workflowAttemptRecord(
  runId: string,
  instanceId: string,
): WorkflowAttemptRecord {
  const parentAttempt = parentAttemptNumber(runId, instanceId);
  if (parentAttempt !== null) {
    return {
      workflow_kind: "parent",
      base_workflow_id: `evidence-${runId}`,
      attempt_number: parentAttempt,
      workflow_instance_id: instanceId,
    };
  }
  const childSuffix = instanceId.match(/-attempt-(0|[1-9]\d*)$/u);
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
      attempt_number: Number.parseInt(childSuffix[1]!, 10) + 2,
      workflow_instance_id: instanceId,
    };
}
