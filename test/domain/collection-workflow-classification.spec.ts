import { expect, test } from "vitest";
import {
  classifyCollectionProgress,
  classifyCollectionWorkflow,
  collectionStallGraceMilliseconds,
  isWorkflowInstanceNotFound,
  parentAttemptNumber,
  parentWorkflowAttemptId,
  safeWorkflowStatus,
  workflowAttemptRecord,
} from "../../src/catalogue/collection-recovery";

const minute = 60_000;
const nowMs = Date.parse("2026-09-02T12:00:00.000Z");

function facts(
  overrides: Partial<Parameters<typeof classifyCollectionWorkflow>[0]>,
): Parameters<typeof classifyCollectionWorkflow>[0] {
  return {
    now_ms: nowMs,
    workflow_status: "running",
    last_progress_ms: nowMs - minute,
    pacing_deadline_ms: null,
    retry_deadline_ms: null,
    ...overrides,
  };
}

test("a dead Workflow classifies by its known status, never by elapsed time", () => {
  expect(classifyCollectionWorkflow(facts({ workflow_status: "errored" })))
    .toEqual({ kind: "recover", reason: "source_workflow_errored" });
  expect(classifyCollectionWorkflow(facts({ workflow_status: "terminated" })))
    .toEqual({ kind: "recover", reason: "source_workflow_terminated" });
  expect(classifyCollectionWorkflow(facts({ workflow_status: "unknown" })))
    .toEqual({ kind: "recover", reason: "source_workflow_unavailable" });
  expect(classifyCollectionWorkflow(facts({ workflow_status: "unavailable" })))
    .toEqual({ kind: "recover", reason: "source_workflow_unavailable" });
});

test("a parent that completed while the run still collects is a stall", () => {
  expect(classifyCollectionWorkflow(facts({
    workflow_status: "complete",
    last_progress_ms: nowMs,
  }))).toEqual({ kind: "recover", reason: "source_workflow_stalled" });
});

test("a paused Workflow instance resumes rather than pausing the run", () => {
  expect(classifyCollectionWorkflow(facts({ workflow_status: "paused" })))
    .toEqual({ kind: "instance_paused" });
});

test("recent persisted progress keeps a running Workflow active", () => {
  expect(classifyCollectionWorkflow(facts({}))).toEqual({ kind: "active" });
  expect(classifyCollectionWorkflow(facts({ workflow_status: "queued" })))
    .toEqual({ kind: "active" });
  expect(classifyCollectionWorkflow(facts({ workflow_status: "waiting" })))
    .toEqual({ kind: "active" });
});

test("silence beyond the grace period stalls a running Workflow", () => {
  expect(classifyCollectionWorkflow(facts({
    last_progress_ms: nowMs - collectionStallGraceMilliseconds - 1,
  }))).toEqual({ kind: "recover", reason: "source_workflow_stalled" });
  expect(classifyCollectionWorkflow(facts({
    last_progress_ms: nowMs - collectionStallGraceMilliseconds,
  }))).toEqual({ kind: "active" });
});

test("a long durable host-pacing sleep is not a stall", () => {
  // Progress stopped hours ago, but the persisted pacing deadline shows the
  // shard is deliberately sleeping until the Official Source may be fetched
  // again.
  expect(classifyCollectionWorkflow(facts({
    last_progress_ms: nowMs - 4 * 60 * minute,
    pacing_deadline_ms: nowMs + minute,
  }))).toEqual({ kind: "active" });
});

test("a scheduled Retry-After wait is not a stall", () => {
  expect(classifyCollectionWorkflow(facts({
    last_progress_ms: nowMs - 4 * 60 * minute,
    retry_deadline_ms: nowMs + 30 * minute,
  }))).toEqual({ kind: "active" });
});

test("an expired wait deadline no longer defers the stall", () => {
  expect(classifyCollectionWorkflow(facts({
    last_progress_ms: nowMs - 4 * 60 * minute,
    pacing_deadline_ms: nowMs - 2 * 60 * minute,
    retry_deadline_ms: nowMs - 3 * 60 * minute,
  }))).toEqual({ kind: "recover", reason: "source_workflow_stalled" });
});

test("a run with no persisted progress evidence at all is stalled", () => {
  expect(classifyCollectionWorkflow(facts({ last_progress_ms: null })))
    .toEqual({ kind: "recover", reason: "source_workflow_stalled" });
});

test("progress facts classify through their persisted ISO deadlines", () => {
  expect(classifyCollectionProgress("running", {
    last_progress_at: "2026-09-02T11:59:00.000Z",
    pacing_deadline_at: null,
    retry_deadline_at: null,
  }, nowMs)).toEqual({ kind: "active" });
  expect(classifyCollectionProgress("running", {
    last_progress_at: "2026-09-02T06:00:00.000Z",
    pacing_deadline_at: null,
    retry_deadline_at: "2026-09-02T12:30:00.000Z",
  }, nowMs)).toEqual({ kind: "active" });
  expect(classifyCollectionProgress("running", {
    last_progress_at: "2026-09-02T06:00:00.000Z",
    pacing_deadline_at: null,
    retry_deadline_at: null,
  }, nowMs)).toEqual({
    kind: "recover",
    reason: "source_workflow_stalled",
  });
  expect(classifyCollectionProgress("errored", {
    last_progress_at: "2026-09-02T11:59:00.000Z",
    pacing_deadline_at: null,
    retry_deadline_at: null,
  }, nowMs)).toEqual({
    kind: "recover",
    reason: "source_workflow_errored",
  });
});

test("a lost instance is distinguished from a transient control-plane error", () => {
  expect(isWorkflowInstanceNotFound(new Error("instance.not_found")))
    .toBe(true);
  expect(isWorkflowInstanceNotFound(new Error("Workflow instance not found")))
    .toBe(true);
  expect(isWorkflowInstanceNotFound(new Error("network timeout"))).toBe(false);
  expect(isWorkflowInstanceNotFound(new Error("internal error"))).toBe(false);
  expect(isWorkflowInstanceNotFound("not an error")).toBe(false);
});

test("workflow statuses map onto the closed safe vocabulary", () => {
  expect(safeWorkflowStatus("running")).toBe("running");
  expect(safeWorkflowStatus("waitingForPause")).toBe("waiting_for_pause");
  expect(safeWorkflowStatus("unknown")).toBe("unknown");
  expect(safeWorkflowStatus(undefined)).toBe("unavailable");
  expect(safeWorkflowStatus("Error: secret leaked")).toBe("unavailable");
});

test("parent Workflow attempt identities and numbers are deterministic", () => {
  expect(parentWorkflowAttemptId("run_1", 1)).toBe("evidence-run_1");
  expect(parentWorkflowAttemptId("run_1", 2)).toBe("evidence-run_1-resume-1");
  expect(parentWorkflowAttemptId("run_1", 5)).toBe("evidence-run_1-resume-4");
  expect(parentAttemptNumber("run_1", "evidence-run_1")).toBe(1);
  expect(parentAttemptNumber("run_1", "evidence-run_1-resume-3")).toBe(4);
  expect(parentAttemptNumber("run_1", "unrelated")).toBe(null);
});

test("attempt records derive their scope from the instance identity", () => {
  expect(workflowAttemptRecord("run_1", "evidence-run_1")).toEqual({
    workflow_kind: "parent",
    base_workflow_id: "evidence-run_1",
    attempt_number: 1,
    workflow_instance_id: "evidence-run_1",
  });
  expect(workflowAttemptRecord("run_1", "evidence-run_1-resume-2")).toEqual({
    workflow_kind: "parent",
    base_workflow_id: "evidence-run_1",
    attempt_number: 3,
    workflow_instance_id: "evidence-run_1-resume-2",
  });
  expect(workflowAttemptRecord("run_1", "evidence-host-abc123")).toEqual({
    workflow_kind: "child",
    base_workflow_id: "evidence-host-abc123",
    attempt_number: 1,
    workflow_instance_id: "evidence-host-abc123",
  });
  expect(
    workflowAttemptRecord("run_1", "evidence-host-abc123-attempt-1"),
  ).toEqual({
    workflow_kind: "child",
    base_workflow_id: "evidence-host-abc123",
    attempt_number: 3,
    workflow_instance_id: "evidence-host-abc123-attempt-1",
  });
});
