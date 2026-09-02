import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  pauseEvidenceRunForWorkflowRecovery,
} from "../../../src/catalogue/source-evidence-repository";
import {
  administrationRequest,
  createCollection,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceRun,
  waitForWorkflowStatus,
} from "./runtime-helpers";

installRuntimeSuite();

// Holds the parent Workflow at its record step so a test can observe or kill
// a live parent deterministically: recordWorkflowIds is the only writer of
// child_workflow_ids_json, while the resume endpoint touches only
// parent_workflow_id.
async function holdParentAtRecordStep(): Promise<void> {
  await env.CATALOGUE_DB.prepare(
    `CREATE TRIGGER hold_child_workflow_ids
     BEFORE UPDATE OF child_workflow_ids_json ON ingestion_evidence_plans
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_record_step_outage');
     END`,
  ).run();
}

async function releaseParentRecordStep(): Promise<void> {
  await env.CATALOGUE_DB.prepare(
    "DROP TRIGGER hold_child_workflow_ids",
  ).run();
}

async function resumeDocument(runId: string): Promise<{
  status: number;
  document: Record<string, unknown>;
}> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    "POST",
  );
  return {
    status: response.status,
    document: await response.json<Record<string, unknown>>(),
  };
}

test("a recorded Workflow Pause is inspectable, immutable, and resumable", async () => {
  const run = await createCollection(
    "workflow_pause_inspection_001",
    "https://official-source.invalid/cards",
  );
  const parentId = `evidence-${run.id}`;
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
     WHERE ingestion_run_id = ?`,
  ).bind(parentId, run.id).run();
  await pauseEvidenceRunForWorkflowRecovery(env.CATALOGUE_DB, run.id, {
    workflow_instance_id: parentId,
    pause_reason: "source_workflow_stalled",
    workflow_status: "running",
    last_progress_at: "2026-09-02T00:00:00.000Z",
  });

  const paused = await showCollection(run.id);
  expect(paused).toMatchObject({
    state: "paused",
    failure_code: null,
    pause: {
      reason: "source_workflow_stalled",
      workflow_instance_id: parentId,
      workflow_status: "running",
      last_progress_at: "2026-09-02T00:00:00.000Z",
      actions: ["resume"],
    },
  });
  await expect(
    env.CATALOGUE_DB.prepare(
      "UPDATE ingestion_run_workflow_pauses SET workflow_status = 'errored'",
    ).run(),
  ).rejects.toThrowError(/workflow_pause_immutable/u);
  await expect(
    env.CATALOGUE_DB.prepare(
      "DELETE FROM ingestion_run_workflow_pauses",
    ).run(),
  ).rejects.toThrowError(/workflow_pause_immutable/u);

  const resumed = await resumeDocument(run.id);
  expect(resumed.status).toBe(202);
  expect(resumed.document).toMatchObject({
    ingestion_run_id: run.id,
    workflow: {
      id: `evidence-${run.id}-resume-1`,
      attempt_number: 2,
    },
  });
  const completed = await waitForEvidenceRun(run.id, "parsing");
  expect(completed.snapshots).toHaveLength(1);
  expect(completed.workflow.current_attempt).toMatchObject({
    id: `evidence-${run.id}-resume-1`,
    attempt_number: 2,
  });
  const parentAttempts = completed.workflow.attempts
    .filter((attempt) => attempt.kind === "parent");
  expect(parentAttempts.map((attempt) => ({
    id: attempt.id,
    attempt_number: attempt.attempt_number,
    current: attempt.current,
  }))).toEqual([
    { id: parentId, attempt_number: 1, current: false },
    { id: `evidence-${run.id}-resume-1`, attempt_number: 2, current: true },
  ]);
  await expect(
    env.CATALOGUE_DB.prepare(
      "DELETE FROM ingestion_workflow_attempts",
    ).run(),
  ).rejects.toThrowError(/workflow_attempt_immutable/u);
});

test("an errored parent Workflow recovers as a recorded new attempt without duplicate evidence", async () => {
  const run = await createCollection(
    "workflow_errored_recovery_001",
    "https://official-source.invalid/cards",
  );
  await holdParentAtRecordStep();
  const started = await resumeDocument(run.id);
  expect(started.status).toBe(202);
  const parentId = `evidence-${run.id}`;
  await waitForWorkflowStatus(
    parentId,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).status(),
    "errored",
    20_000,
  );
  await releaseParentRecordStep();

  const recovered = await resumeDocument(run.id);
  expect(recovered.status).toBe(202);
  expect(recovered.document).toMatchObject({
    ingestion_run_id: run.id,
    workflow: {
      id: `evidence-${run.id}-resume-1`,
      attempt_number: 2,
    },
    recovery: {
      reason: "source_workflow_errored",
      superseded_workflow_id: parentId,
      workflow_status: "errored",
    },
  });

  const completed = await waitForEvidenceRun(run.id, "parsing", 20_000);
  // The retained collection work is preserved, not repeated: one Source
  // Snapshot, one Source Observation Set, and exactly one successful fetch
  // attempt for the lone Source Request.
  expect(completed.snapshots).toHaveLength(1);
  expect(completed.observation_sets).toHaveLength(1);
  expect(
    completed.diagnostics.filter((entry) => entry.outcome === "success"),
  ).toHaveLength(1);
  const captureOperations = await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_capture_operations
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first<{ count: number }>();
  expect(captureOperations?.count).toBe(1);

  const pauseRecord = await env.CATALOGUE_DB.prepare(
    `SELECT pause_reason, workflow_instance_id, workflow_status,
            last_progress_at
     FROM ingestion_run_workflow_pauses WHERE ingestion_run_id = ?`,
  ).bind(run.id).first<Record<string, unknown>>();
  expect(pauseRecord).toMatchObject({
    pause_reason: "source_workflow_errored",
    workflow_instance_id: parentId,
    workflow_status: "errored",
  });
  expect(pauseRecord?.last_progress_at).toMatch(
    /^\d{4}-\d{2}-\d{2}T/u,
  );
  const transitions = await env.CATALOGUE_DB.prepare(
    `SELECT from_state, to_state FROM ingestion_run_transitions
     WHERE ingestion_run_id = ? ORDER BY sequence`,
  ).bind(run.id).all<{ from_state: string; to_state: string }>();
  expect(transitions.results).toEqual([
    { from_state: null, to_state: "collecting" },
    { from_state: "collecting", to_state: "paused" },
    { from_state: "paused", to_state: "collecting" },
    { from_state: "collecting", to_state: "parsing" },
  ]);
});

test("a terminated parent Workflow recovers with its own safe reason", async () => {
  const run = await createCollection(
    "workflow_terminated_recovery_001",
    "https://official-source.invalid/cards",
  );
  await holdParentAtRecordStep();
  const started = await resumeDocument(run.id);
  expect(started.status).toBe(202);
  const parentId = `evidence-${run.id}`;
  await (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).terminate();
  await waitForWorkflowStatus(
    parentId,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).status(),
    "terminated",
    20_000,
  );
  await releaseParentRecordStep();

  const recovered = await resumeDocument(run.id);
  expect(recovered.status).toBe(202);
  expect(recovered.document).toMatchObject({
    workflow: { id: `evidence-${run.id}-resume-1`, attempt_number: 2 },
    recovery: {
      reason: "source_workflow_terminated",
      superseded_workflow_id: parentId,
      workflow_status: "terminated",
    },
  });
  const completed = await waitForEvidenceRun(run.id, "parsing", 20_000);
  expect(completed.snapshots).toHaveLength(1);
});

test("a bound but never-created parent instance is recreated under its own identity", async () => {
  const run = await createCollection(
    "workflow_missing_instance_001",
    "https://official-source.invalid/cards",
  );
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
     WHERE ingestion_run_id = ?`,
  ).bind(`evidence-${run.id}`, run.id).run();

  const resumed = await resumeDocument(run.id);
  expect(resumed.status).toBe(202);
  // Reacquiring a lost identity recreates the same deterministic attempt
  // rather than misclassifying the run or opening a competing attempt.
  expect(resumed.document).toMatchObject({
    workflow: { id: `evidence-${run.id}`, attempt_number: 1 },
  });
  expect(resumed.document.recovery).toBeUndefined();
  const completed = await waitForEvidenceRun(run.id, "parsing", 20_000);
  expect(completed.snapshots).toHaveLength(1);
});

test("concurrent resumes of a dead Workflow cannot create competing attempts", async () => {
  const run = await createCollection(
    "workflow_concurrent_recovery_001",
    "https://official-source.invalid/cards",
  );
  await holdParentAtRecordStep();
  const started = await resumeDocument(run.id);
  expect(started.status).toBe(202);
  const parentId = `evidence-${run.id}`;
  await waitForWorkflowStatus(
    parentId,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).status(),
    "errored",
    20_000,
  );
  await releaseParentRecordStep();

  const [first, second] = await Promise.all([
    resumeDocument(run.id),
    resumeDocument(run.id),
  ]);
  for (const resumed of [first, second]) {
    expect(resumed.status).toBe(202);
    expect(resumed.document).toMatchObject({
      workflow: { id: `evidence-${run.id}-resume-1`, attempt_number: 2 },
    });
  }
  const parentAttempts = await env.CATALOGUE_DB.prepare(
    `SELECT workflow_instance_id FROM ingestion_workflow_attempts
     WHERE ingestion_run_id = ? AND workflow_kind = 'parent'
     ORDER BY attempt_number`,
  ).bind(run.id).all<{ workflow_instance_id: string }>();
  expect(parentAttempts.results.map((row) => row.workflow_instance_id))
    .toEqual([parentId, `evidence-${run.id}-resume-1`]);
  const resumeTransitions = await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_transitions
     WHERE ingestion_run_id = ?
       AND from_state = 'paused' AND to_state = 'collecting'`,
  ).bind(run.id).first<{ count: number }>();
  expect(resumeTransitions?.count).toBe(1);
  const pauseRecords = await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_workflow_pauses
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first<{ count: number }>();
  expect(pauseRecords?.count).toBe(1);
  await waitForEvidenceRun(run.id, "parsing", 20_000);
});

test("inspection classifies a healthy collecting Workflow without pausing it", async () => {
  const run = await createCollection(
    "workflow_active_inspection_001",
    "https://official-source.invalid/cards",
  );
  const started = await resumeDocument(run.id);
  expect(started.status).toBe(202);
  const completed = await waitForEvidenceRun(run.id, "parsing", 20_000);
  expect(completed.workflow.last_progress_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(completed.workflow.status).toBeDefined();
  // A run beyond its collection phase carries no stall classification.
  expect(completed.workflow.classification).toBeUndefined();
  expect(completed.workflow.current_attempt).toMatchObject({
    id: `evidence-${run.id}`,
    attempt_number: 1,
  });
});
