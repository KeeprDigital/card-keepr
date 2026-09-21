import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  pauseAcquisitionOwnership,
  reserveAcquisitionDispatch,
} from "../../../src/catalogue/source-evidence/acquisition-budget";
import {
  pendingEvidenceRequests,
  prepareCaptureAttempt,
  recordWorkflowIds,
  requiredEvidenceRun,
  resumeEvidenceRun,
  showEvidenceRun,
  workflowAttemptStatements,
} from "../../../src/catalogue/source-evidence";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import { dispatchReservation, rawWriterCompletion } from "./query-helpers/acquisition-recovery";
import {
  administrationRequest,
  type CollectionDocument,
  createCollection,
  installRuntimeSuite,
  waitForEvidenceCondition,
  waitForWorkflowStatus,
} from "./runtime-helpers";

installRuntimeSuite();

// The synthetic hostname attempt that reserved a dispatch and was then
// replaced, exactly as a parent replaces a terminated child. Only this
// identity is intercepted; every real host Workflow attempt keeps reaching the
// platform.
const owner = "evidence-host-terminal-owner";
const successor = `${owner}-attempt-0`;

function hostWorkflowReporting(outcome: string | Error): typeof env.EVIDENCE_HOST_WORKFLOW {
  return new Proxy(env.EVIDENCE_HOST_WORKFLOW, {
    get(target, property) {
      if (property === "get")
        return async (id: string) => {
          if (id !== owner) return target.get(id);
          if (outcome instanceof Error) throw outcome;
          return { status: async () => ({ status: outcome }) };
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function pausedRunWithHeldDispatch(idempotencyKey: string) {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: idempotencyKey,
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  const parentId = `evidence-${runId}`;
  await recordWorkflowIds(database, runId, parentId, [owner]);
  await database.batch(workflowAttemptStatements(database, runId, [parentId, owner]));
  const request = (await pendingEvidenceRequests(database, runId))[0]!;
  const prepared = await prepareCaptureAttempt(database, await requiredEvidenceRun(database, runId), request);
  if (prepared.kind !== "attempt") throw new Error("Expected an unstarted capture");
  const dispatchId = await reserveAcquisitionDispatch(database, {
    runId,
    requestId: request.request_id,
    captureId: prepared.attempt_id,
    objectKey: prepared.content_object_key,
    maximumBytes: 16 * 1024 * 1024,
    workflow: { parentId, instanceId: owner },
  });
  if (dispatchId === null) throw new Error("Expected a charged Dispatch Reservation");
  // The replacement attempt supersedes the owner without settling its dispatch.
  await database.batch(workflowAttemptStatements(database, runId, [successor]));
  await pauseAcquisitionOwnership(database, { runId, requestId: request.request_id, captureId: prepared.attempt_id });
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "ownership" },
    acquisition: {
      charged_dispatches: 1,
      reserved_source_bytes: 16 * 1024 * 1024,
      unsettled: [{ id: dispatchId, workflow_instance_id: owner }],
    },
  });
  return { database, runId, dispatchId, objectKey: prepared.content_object_key };
}

function resume(database: ReturnType<typeof catalogueStore>, runId: string, outcome: string | Error) {
  return resumeEvidenceRun(
    database,
    env.EVIDENCE_INGESTION_WORKFLOW,
    runId,
    hostWorkflowReporting(outcome),
    env.EVIDENCE_OBJECTS,
  );
}

test.each(["running", "queued"])("a dispatch held by a %s Workflow Attempt keeps blocking resume", async (status) => {
  const { database, runId, dispatchId } = await pausedRunWithHeldDispatch(`acquisition_terminal_owner_${status}_001`);
  await expect(resume(database, runId, status)).rejects.toMatchObject({
    status: 409,
    code: "source_acquisition_ownership_pending",
  });
  expect(await dispatchReservation(env.CATALOGUE_DB, dispatchId).first()).toMatchObject({ settled_at: null });
  expect(await rawWriterCompletion(env.CATALOGUE_DB, dispatchId).first()).toMatchObject({ completed_at: null });
  expect((await showEvidenceRun(database, runId)).state).toBe("paused");
});

test("a control-plane failure other than confirmed absence settles nothing", async () => {
  const { database, runId, dispatchId } = await pausedRunWithHeldDispatch("acquisition_terminal_owner_outage_001");
  await expect(resume(database, runId, new Error("synthetic status control-plane outage"))).rejects.toThrow(
    "synthetic status control-plane outage",
  );
  expect(await dispatchReservation(env.CATALOGUE_DB, dispatchId).first()).toMatchObject({ settled_at: null });
  expect((await showEvidenceRun(database, runId)).state).toBe("paused");
});

test("a present destination keeps a terminated owner's dispatch for exact writer verification", async () => {
  const { database, runId, dispatchId, objectKey } = await pausedRunWithHeldDispatch(
    "acquisition_terminal_owner_late_body_001",
  );
  await env.EVIDENCE_OBJECTS.put(objectKey, new TextEncoder().encode('{"cards":[]}'), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { cleanup_writer_token: dispatchId },
  });
  await expect(resume(database, runId, "terminated")).rejects.toMatchObject({
    status: 409,
    code: "source_acquisition_ownership_pending",
  });
  expect(await dispatchReservation(env.CATALOGUE_DB, dispatchId).first()).toMatchObject({ settled_at: null });
  expect(await rawWriterCompletion(env.CATALOGUE_DB, dispatchId).first()).toMatchObject({ completed_at: null });
});

test.each([
  ["terminated", "terminated"],
  ["confirmed absent", new Error("instance.not_found")],
] as const)(
  "a %s owner's dispatch without a destination settles at zero bytes and collection completes",
  async (_label, outcome) => {
    const { database, runId, dispatchId, objectKey } = await pausedRunWithHeldDispatch(
      `acquisition_terminal_owner_settled_${typeof outcome === "string" ? outcome : "absent"}_001`,
    );
    expect(await env.EVIDENCE_OBJECTS.head(objectKey)).toBeNull();
    await expect(resume(database, runId, outcome)).resolves.toMatchObject({ ingestion_run_id: runId });
    const reservation = await dispatchReservation(env.CATALOGUE_DB, dispatchId).first<{
      settled_at: string | null;
      charged_source_bytes: number | null;
    }>();
    expect(reservation).toMatchObject({ charged_source_bytes: 0 });
    expect(reservation?.settled_at).not.toBeNull();
    expect(
      (await rawWriterCompletion(env.CATALOGUE_DB, dispatchId).first<{ completed_at: string | null }>())?.completed_at,
    ).not.toBeNull();
    const completed = await waitForEvidenceCondition(
      runId,
      (current) => current.collection_completed_at !== null,
      15_000,
    );
    expect(completed.snapshots).toHaveLength(1);
    // The abandoned attempt is a recorded failure; the replacement retrieved
    // under attempt 2 and a fresh object key. The dead dispatch stays charged.
    expect(completed.diagnostics.map(({ attempt_number, outcome }) => ({ attempt_number, outcome }))).toEqual([
      { attempt_number: 1, outcome: "network_failure" },
      { attempt_number: 2, outcome: "success" },
    ]);
    expect(await showEvidenceRun(database, runId)).toMatchObject({
      acquisition: { charged_dispatches: 2, reserved_source_bytes: 0, unsettled: [] },
    });
  },
);

function unsettledDispatchCount(current: CollectionDocument): number {
  const acquisition = (current as unknown as { acquisition: { unsettled: unknown[] } | null }).acquisition;
  return acquisition?.unsettled.length ?? 0;
}

test("a hostname Workflow terminated while holding a dispatch is settled by its parent and the replacement completes", async () => {
  const run = await createCollection(
    "acquisition_terminal_owner_workflow_001",
    "https://acquisition-official-source.invalid/hold/terminal-owner-workflow-001",
  );
  const started = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const holding = await waitForEvidenceCondition(
    run.id,
    (current) => current.workflow.child_ids.length === 1 && unsettledDispatchCount(current) === 1,
    15_000,
  );
  const childId = holding.workflow.child_ids[0]!;
  await (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).terminate();
  await waitForWorkflowStatus(
    childId,
    async () => (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).status(),
    "terminated",
    15_000,
  );
  // Releasing the held body lets the replacement proceed. Only the
  // replacement's attempt can become evidence; the dead attempt was abandoned.
  const released = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(
    "https://acquisition-official-source.invalid/release/terminal-owner-workflow-001",
  );
  expect(released.status).toBe(204);
  const completed = await waitForEvidenceCondition(
    run.id,
    (current) => current.collection_completed_at !== null,
    30_000,
  );
  expect(completed.snapshots).toHaveLength(1);
  // Termination may land before or after the response headers arrive, so the
  // abandoned attempt is a transport or a storage failure; never evidence.
  expect(completed.diagnostics.map(({ attempt_number, outcome }) => ({ attempt_number, outcome }))).toEqual([
    { attempt_number: 1, outcome: expect.stringMatching(/^(network|storage)_failure$/u) },
    { attempt_number: 2, outcome: "success" },
  ]);
  expect(await showEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id)).toMatchObject({
    acquisition: { charged_dispatches: 2, reserved_source_bytes: 0, unsettled: [] },
  });
});
