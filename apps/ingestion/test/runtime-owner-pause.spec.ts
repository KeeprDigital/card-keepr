import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  administrationRequest,
  createCollection,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceRun,
  waitForWorkflowStatus,
} from "./runtime-helpers";

installRuntimeSuite();

// Holds the parent Workflow at its record step so a test can pause a live,
// running parent deterministically (see runtime-workflow-recovery.spec.ts).
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

async function requestPause(
  runId: string,
  idempotencyKey: string,
): Promise<{ status: number; document: Record<string, unknown> }> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/pause`,
    "POST",
    { idempotency_key: idempotencyKey },
  );
  return {
    status: response.status,
    document: await response.json<Record<string, unknown>>(),
  };
}

test("an owner pause stops a live collecting run so it can be terminated without resuming", async () => {
  const run = await createCollection(
    "owner_pause_terminate_001",
    "https://official-source.invalid/cards",
  );
  await holdParentAtRecordStep();
  const started = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const parentId = `evidence-${run.id}`;

  const paused = await requestPause(run.id, "owner_pause_terminate_001_pause");
  expect(paused.status).toBe(200);
  expect(paused.document).toMatchObject({
    contract: "card-keepr-collection-pause@1",
    ingestion_run_id: run.id,
    state: "paused",
    pause_reason: "owner_requested",
    workflow: { id: parentId, attempt_number: 1 },
    actions: ["resume", "terminate"],
  });
  expect(paused.document.paused_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

  // The pause is recorded exactly like the other Workflow Pause kinds, and
  // the superseded parent attempt is fenced off best-effort.
  const shown = await showCollection(run.id);
  expect(shown).toMatchObject({
    state: "paused",
    failure_code: null,
    pause: {
      reason: "owner_requested",
      workflow_instance_id: parentId,
      actions: ["resume", "terminate"],
    },
    actions: ["resume", "terminate"],
  });
  await waitForWorkflowStatus(
    parentId,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).status(),
    "terminated",
    20_000,
  );
  await releaseParentRecordStep();

  const terminated = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/termination`,
    "POST",
    { idempotency_key: "owner_pause_terminate_001_terminate" },
  );
  expect(terminated.status).toBe(200);
  await expect(terminated.json()).resolves.toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
    pause_reason: "owner_requested",
    active_run_released: true,
  });
  const abandoned = await showCollection(run.id);
  expect(abandoned).toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
    termination: { pause_reason: "owner_requested" },
    actions: ["retry"],
  });
  expect(
    abandoned.workflow.attempts.filter((attempt) => attempt.kind === "parent"),
  ).toHaveLength(1);
});

test("an owner-paused live run resumes under a new Workflow Attempt and completes", async () => {
  const run = await createCollection(
    "owner_pause_resume_001",
    "https://official-source.invalid/cards",
  );
  await holdParentAtRecordStep();
  const started = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const parentId = `evidence-${run.id}`;

  const paused = await requestPause(run.id, "owner_pause_resume_001_pause");
  expect(paused.status).toBe(200);
  expect(paused.document).toMatchObject({
    state: "paused",
    pause_reason: "owner_requested",
    workflow: { id: parentId, attempt_number: 1, status: "running" },
  });
  await waitForWorkflowStatus(
    parentId,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).status(),
    "terminated",
    20_000,
  );
  await releaseParentRecordStep();

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  const resumedDocument = await resumed.json<Record<string, unknown>>();
  expect(resumedDocument).toMatchObject({
    ingestion_run_id: run.id,
    workflow: { id: `${parentId}-resume-1`, attempt_number: 2 },
  });
  expect(resumedDocument.recovery).toBeUndefined();

  const completed = await waitForEvidenceRun(run.id, "parsing", 20_000);
  expect(completed.snapshots).toHaveLength(1);
  expect(
    completed.diagnostics.filter((entry) => entry.outcome === "success"),
  ).toHaveLength(1);
  expect(
    completed.workflow.attempts
      .filter((attempt) => attempt.kind === "parent")
      .map((attempt) => ({
        id: attempt.id,
        attempt_number: attempt.attempt_number,
        current: attempt.current,
      })),
  ).toEqual([
    { id: parentId, attempt_number: 1, current: false },
    { id: `${parentId}-resume-1`, attempt_number: 2, current: true },
  ]);
  const transitions = await env.CATALOGUE_DB.prepare(
    `SELECT from_state, to_state FROM ingestion_run_transitions
     WHERE ingestion_run_id = ? ORDER BY sequence`,
  ).bind(run.id).all<{ from_state: string | null; to_state: string }>();
  expect(transitions.results).toEqual([
    { from_state: null, to_state: "collecting" },
    { from_state: "collecting", to_state: "paused" },
    { from_state: "paused", to_state: "collecting" },
    { from_state: "collecting", to_state: "parsing" },
  ]);
});

test("an owner pause replays idempotently and refuses a run that is not collecting", async () => {
  const run = await createCollection(
    "owner_pause_idempotent_001",
    "https://official-source.invalid/cards",
  );
  // A first attempt that never started is paused under its bound identity
  // and reports the instance as unavailable.
  const first = await requestPause(run.id, "owner_pause_idempotent_001_pause");
  expect(first.status).toBe(200);
  expect(first.document).toMatchObject({
    workflow: { id: `evidence-${run.id}`, attempt_number: 1, status: "unavailable" },
  });

  const replayed = await requestPause(run.id, "owner_pause_idempotent_001_pause");
  expect(replayed.status).toBe(200);
  expect(replayed.document).toEqual(first.document);
  const pauses = await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM ingestion_run_workflow_pauses WHERE ingestion_run_id = ?",
  ).bind(run.id).first<{ count: number }>();
  expect(pauses?.count).toBe(1);

  // A new request against the already-paused run is a typed state conflict.
  const alreadyPaused = await requestPause(run.id, "owner_pause_idempotent_001_again");
  expect(alreadyPaused.status).toBe(409);
  expect(alreadyPaused.document).toMatchObject({
    code: "ingestion_run_not_collecting",
  });

  // A terminated run cannot be paused either.
  const terminated = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/termination`,
    "POST",
    { idempotency_key: "owner_pause_idempotent_001_terminate" },
  );
  expect(terminated.status).toBe(200);
  await terminated.body?.cancel();
  const afterTermination = await requestPause(run.id, "owner_pause_idempotent_001_late");
  expect(afterTermination.status).toBe(409);
  expect(afterTermination.document).toMatchObject({
    code: "ingestion_run_not_collecting",
  });

  // The key belongs to the first run: reusing it for another run is refused.
  const other = await createCollection(
    "owner_pause_idempotent_002",
    "https://official-source.invalid/cards",
  );
  const reused = await requestPause(other.id, "owner_pause_idempotent_001_pause");
  expect(reused.status).toBe(409);
  expect(reused.document).toMatchObject({ code: "idempotency_conflict" });
});

test("inspection lists pause as the available action while a run collects", async () => {
  const run = await createCollection(
    "owner_pause_actions_001",
    "https://official-source.invalid/cards",
  );
  const collecting = await showCollection(run.id);
  expect(collecting.state).toBe("collecting");
  expect(collecting.actions).toEqual(["pause"]);
});
