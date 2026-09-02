import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  pauseEvidenceRunForWorkflowRecovery,
  resumePausedEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  canonicalJson,
  sha256,
  utf8,
} from "../../../src/catalogue/serialization";
import {
  administrationRequest,
  clearActiveRunForNextScenario,
  type CollectionDocument,
  createCollection,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceCondition,
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

async function terminateBestEffort(
  workflow: Workflow,
  instanceId: string,
): Promise<void> {
  try {
    await (await workflow.get(instanceId)).terminate();
  } catch {
    // Already settled.
  }
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
      actions: ["resume", "terminate"],
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

test("child identity exhaustion fails only the exhausted hostname shard", async () => {
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "workflow_scoped_exhaustion_001",
    requests: [
      {
        id: "healthy-host",
        url: "https://mapping-a-official-source.invalid/cards",
      },
      {
        id: "exhausted-host",
        url: "https://mapping-z-official-source.invalid/cards",
      },
    ],
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const baseChildId = `evidence-host-${await sha256(utf8(canonicalJson({
    ingestion_run_id: run.id,
    hostname: "mapping-z-official-source.invalid",
    minimum_sequence_number: 0,
    maximum_sequence_number: 199,
  })))}`;
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_evidence_plans SET child_workflow_ids_json = ?
     WHERE ingestion_run_id = ?`,
  ).bind(
    canonicalJson([
      baseChildId,
      `${baseChildId}-attempt-0`,
      `${baseChildId}-attempt-1`,
      `${baseChildId}-attempt-2`,
    ]),
    run.id,
  ).run();

  const resumed = await resumeDocument(run.id);
  expect(resumed.status).toBe(202);
  const terminal = await waitForEvidenceCondition(
    run.id,
    (current) => current.state !== "collecting",
    20_000,
  );
  expect(terminal).toMatchObject({
    state: "failed",
    failure_code: "source_workflow_retries_exhausted",
  });
  const requestStates = await env.CATALOGUE_DB.prepare(
    `SELECT request_id, state FROM source_requests
     WHERE ingestion_run_id = ? ORDER BY request_id`,
  ).bind(run.id).all<{ request_id: string; state: string }>();
  const byRequest = Object.fromEntries(
    requestStates.results.map((row) => [row.request_id, row.state]),
  );
  // Only the exhausted hostname's shard fails; the healthy host's request
  // is never marked failed by another shard's identity exhaustion.
  expect(byRequest["exhausted-host"]).toBe("failed");
  expect(byRequest["healthy-host"]).not.toBe("failed");
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

test("a parent Workflow that completed with a request still pending resumes as a new attempt without duplicate fetches", async () => {
  // Issue #70: the resume endpoint once restarted a completed parent from a
  // step name that does not exist. A completed parent is now classified as
  // stalled and superseded by a deterministic new attempt that pulls only
  // the pending work from D1, so retained evidence is never fetched again.
  //
  // A healthy parent replaces its own dead hostname shards and only ends
  // once the run leaves collection, so the reproduction shape (a completed
  // instance holding the run's current attempt identity while one Source
  // Request is captured and another is still pending) is staged: the run
  // collects one host and is refused by the other with a long Retry-After,
  // its first attempt is fenced off, and the instance under the next attempt
  // identity is created to drive an already-parsed run so it completes at
  // once without touching this run's evidence.
  const parsed = await createCollection(
    "workflow_completed_parent_donor_001",
    "https://official-source.invalid/cards",
  );
  expect((await resumeDocument(parsed.id)).status).toBe(202);
  await waitForEvidenceRun(parsed.id, "parsing", 20_000);
  await clearActiveRunForNextScenario();

  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "workflow_completed_parent_resume_001",
    requests: [
      {
        id: "captured-host",
        url: "https://mapping-a-official-source.invalid/cards",
      },
      {
        id: "pending-host",
        url: "https://completed-parent-official-source.invalid/retry-once-slow",
      },
    ],
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  expect((await resumeDocument(run.id)).status).toBe(202);
  const interrupted = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.snapshots.length === 1 &&
      current.diagnostics.some(
        (diagnostic) =>
          diagnostic.request_id === "pending-host" &&
          diagnostic.outcome === "http_failure",
      ),
    20_000,
  );
  const firstParentId = `evidence-${run.id}`;
  // Fence the first attempt off: the captured host's shard has already
  // settled, so termination is best effort exactly as in production.
  await terminateBestEffort(env.EVIDENCE_INGESTION_WORKFLOW, firstParentId);
  for (const childId of interrupted.workflow.child_ids) {
    await terminateBestEffort(env.EVIDENCE_HOST_WORKFLOW, childId);
  }
  await pauseEvidenceRunForWorkflowRecovery(env.CATALOGUE_DB, run.id, {
    workflow_instance_id: firstParentId,
    pause_reason: "source_workflow_terminated",
    workflow_status: "terminated",
    last_progress_at: interrupted.workflow.last_progress_at,
  });
  await resumePausedEvidenceRun(env.CATALOGUE_DB, run.id);
  const completedParentId = `evidence-${run.id}-resume-1`;
  await env.EVIDENCE_INGESTION_WORKFLOW.create({
    id: completedParentId,
    params: { ingestion_run_id: parsed.id },
  });
  await waitForWorkflowStatus(
    completedParentId,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(completedParentId)).status(),
    "complete",
    20_000,
  );
  const stalled = await showCollection(run.id);
  expect(stalled.state).toBe("collecting");
  expect(stalled.workflow.parent_id).toBe(completedParentId);
  expect(stalled.snapshots).toHaveLength(1);

  const recovered = await resumeDocument(run.id);
  expect(recovered.status).toBe(202);
  expect(recovered.document).toMatchObject({
    ingestion_run_id: run.id,
    workflow: {
      id: `evidence-${run.id}-resume-2`,
      attempt_number: 3,
    },
    recovery: {
      reason: "source_workflow_stalled",
      superseded_workflow_id: completedParentId,
      workflow_status: "complete",
    },
  });

  const completed = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.state === "parsing" &&
      current.snapshots.length === 2 &&
      current.observation_sets.length === 2,
    25_000,
  );
  // Only the pending request is fetched again: the captured host keeps its
  // single successful fetch and single capture operation, while the pending
  // host records its refusal and then exactly one success.
  const outcomesByRequest = new Map<string, string[]>();
  for (const entry of completed.diagnostics) {
    outcomesByRequest.set(entry.request_id, [
      ...(outcomesByRequest.get(entry.request_id) ?? []),
      entry.outcome,
    ]);
  }
  expect(outcomesByRequest.get("captured-host")).toEqual(["success"]);
  expect(outcomesByRequest.get("pending-host")?.sort())
    .toEqual(["http_failure", "success"]);
  const captureOperations = await env.CATALOGUE_DB.prepare(
    `SELECT request_id, COUNT(*) AS count FROM source_capture_operations
     WHERE ingestion_run_id = ? GROUP BY request_id ORDER BY request_id`,
  ).bind(run.id).all<{ request_id: string; count: number }>();
  expect(captureOperations.results).toEqual([
    { request_id: "captured-host", count: 1 },
    { request_id: "pending-host", count: 2 },
  ]);
  expect(completed.workflow.current_attempt).toMatchObject({
    id: `evidence-${run.id}-resume-2`,
    attempt_number: 3,
  });
  const parentAttempts = completed.workflow.attempts
    .filter((attempt) => attempt.kind === "parent")
    .map((attempt) => attempt.id);
  expect(parentAttempts).toEqual([
    firstParentId,
    completedParentId,
    `evidence-${run.id}-resume-2`,
  ]);
}, 60_000);
