import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  finalizeEvidenceRun,
  pauseEvidenceRunForRequestCapacity,
  pauseEvidenceRunForWorkflowRecovery,
  pendingEvidenceRequests,
  prepareCaptureAttempt,
  RequestCapacityProblem,
  requiredEvidenceRun,
  resumeEvidenceRun,
  resumePausedEvidenceRun,
  terminateEvidenceCollection,
} from "../../../src/catalogue/source-evidence";
import { pauseRunAtCapacity } from "./capacity-pause-helpers";
import { dropPausePrerequisiteGuards } from "./query-helpers/collection-resume";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import {
  administrationRequest,
  clearActiveRunForNextScenario,
  createCollection,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceCondition,
  waitForWorkflowStatus,
} from "./runtime-helpers";

installRuntimeSuite();
beforeEach(() => dropPausePrerequisiteGuards(env.CATALOGUE_DB));

async function pauseForWorkflowRecovery(
  runId: string,
  reason: "source_workflow_stalled" | "source_workflow_errored",
): Promise<void> {
  await sourceEvidenceQueries
    .setIngestionEvidencePlansParentWorkflowId(env.CATALOGUE_DB)
    .bind(`evidence-${runId}`, runId)
    .run();
  await pauseEvidenceRunForWorkflowRecovery(catalogueStore(env.CATALOGUE_DB), runId, {
    workflow_instance_id: `evidence-${runId}`,
    pause_reason: reason,
    workflow_status: reason === "source_workflow_errored" ? "errored" : "running",
    last_progress_at: null,
  });
  expect(await ingestionQueries.readIngestionRunsState(env.CATALOGUE_DB).bind(runId).first("state")).toBe("paused");
}

type RetainedEvidenceCounts = {
  snapshots: unknown;
  observation_sets: unknown;
  fetch_attempts: unknown;
  discovery_plans: unknown;
  capacity_pauses: unknown;
  requests_by_state: Array<{ state: string; count: number }>;
};

// Every retained evidence object a termination must leave untouched.
async function retainedEvidenceCounts(runId: string): Promise<RetainedEvidenceCounts> {
  return {
    snapshots: await sourceEvidenceQueries
      .countSourceSnapshotsCountForBatchThatFailsMidwayReplaysWithoutDuplicatingSnapshotsOrWithundefined(
        env.CATALOGUE_DB,
      )
      .bind(runId)
      .first("count"),
    observation_sets: await sourceEvidenceQueries
      .countSourceObservationSetsCountForRetainedEvidenceCounts(env.CATALOGUE_DB)
      .bind(runId)
      .first("count"),
    fetch_attempts: await sourceEvidenceQueries
      .countSourceFetchAttemptsCount(env.CATALOGUE_DB)
      .bind(runId)
      .first("count"),
    discovery_plans: await sourceEvidenceQueries
      .countSourceDiscoveryRequestPlansCount(env.CATALOGUE_DB)
      .bind(runId)
      .first("count"),
    capacity_pauses: await sourceEvidenceQueries
      .countIngestionRunCapacityPausesCount(env.CATALOGUE_DB)
      .bind(runId)
      .first("count"),
    requests_by_state: (
      await sourceEvidenceQueries
        .countSourceRequestsCountForRetainedEvidenceCounts(env.CATALOGUE_DB)
        .bind(runId)
        .all<{ state: string; count: number }>()
    ).results,
  };
}

test("terminating a paused run records the owner decision, releases the reservation, and retains all evidence", async () => {
  const { runId, snapshotId } = await pauseRunAtCapacity("termination_capacity_001", "observed");
  const before = await retainedEvidenceCounts(runId);
  expect(before.snapshots).toBe(1);
  expect(before.observation_sets).toBe(1);

  const terminated = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/termination`, "POST", {
    idempotency_key: "termination_001",
  });
  expect(terminated.status).toBe(200);
  const document = await terminated.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    contract: "card-keepr-collection-termination@1",
    ingestion_run_id: runId,
    state: "failed",
    failure_code: "ingestion_run_terminated",
    pause_reason: "source_request_capacity_exhausted",
    active_run_released: true,
  });
  expect(document.paused_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(document.terminated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

  // The run is terminal with the stable owner-termination reason, recorded
  // as the paused -> failed transition.
  expect(await ingestionQueries.readIngestionRunsStateTerminalAt(env.CATALOGUE_DB).bind(runId).first()).toEqual({
    state: "failed",
    terminal_at: document.terminated_at,
    failure_code: "ingestion_run_terminated",
  });
  const record = await sourceEvidenceQueries
    .readIngestionRunTerminations(env.CATALOGUE_DB)
    .bind(runId)
    .first<Record<string, unknown>>();
  expect(record).toMatchObject({
    pause_reason: "source_request_capacity_exhausted",
    paused_at: document.paused_at,
    terminated_at: document.terminated_at,
    idempotency_key: "termination_001",
  });
  await expect(
    sourceEvidenceQueries.setIngestionRunTerminationsTerminatedAt(env.CATALOGUE_DB).run(),
  ).rejects.toThrowError(/termination_immutable/u);
  await expect(sourceEvidenceQueries.deleteIngestionRunTerminations(env.CATALOGUE_DB).run()).rejects.toThrowError(
    /termination_immutable/u,
  );

  // The single active-run reservation is released.
  expect(
    await ingestionQueries.readOperationStateActiveIngestionRunId(env.CATALOGUE_DB).first("active_ingestion_run_id"),
  ).toBeNull();

  // No retained evidence object was deleted or re-stated.
  expect(await retainedEvidenceCounts(runId)).toEqual(before);
  expect(
    await sourceEvidenceQueries
      .readSourceRequestsStateSourceSnapshotIdForTerminatingPausedRunRecordsOwnerDecisionReleasesReservationRetains(
        env.CATALOGUE_DB,
      )
      .bind(runId, snapshotId)
      .first(),
  ).toEqual({
    state: "captured",
    source_snapshot_id: snapshotId,
  });

  // Replaying the same termination returns the original result; a second
  // termination under a different key is a state conflict.
  const replayed = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/termination`, "POST", {
    idempotency_key: "termination_001",
  });
  expect(replayed.status).toBe(200);
  await expect(replayed.json()).resolves.toEqual(document);
  const again = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/termination`, "POST", {
    idempotency_key: "termination_002",
  });
  expect(again.status).toBe(409);
  await expect(again.json()).resolves.toMatchObject({
    code: "ingestion_run_not_paused",
  });

  // Inspection reports the terminal owner decision and advertises neither
  // resume nor capacity extension.
  const shown = (await showCollection(runId)) as Record<string, unknown>;
  expect(shown).toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
    termination: {
      reason: "ingestion_run_terminated",
      pause_reason: "source_request_capacity_exhausted",
      paused_at: document.paused_at,
      terminated_at: document.terminated_at,
    },
    actions: ["retry"],
  });
  expect(shown.pause).toBeUndefined();
  expect((shown.snapshots as Array<{ id: string }>).map(({ id }) => id)).toEqual([snapshotId]);
}, 60_000);

test("a terminated run refuses every lifecycle continuation and frees the reservation for a new run", async () => {
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "termination_gates_001",
    requests: [{ id: "cards", url: "https://official-source.invalid/cards" }],
  });
  expect(created.status).toBe(201);
  const run = await created.json<{
    id: string;
    expected_current_revision_id: string;
  }>();
  const revisionsBefore = await publishedCatalogueQueries.countCatalogueRevisionsCount(env.CATALOGUE_DB).first("count");
  await pauseEvidenceRunForRequestCapacity(
    catalogueStore(env.CATALOGUE_DB),
    run.id,
    "cards",
    new RequestCapacityProblem({
      source_lineage: "one-piece-en",
      request_capacity: 5_000,
      capacity_generation: 1,
      used_capacity: 5_000,
      overflow_request_count: 1,
      required_capacity: 5_001,
    }),
  );
  const paused = (await showCollection(run.id)) as Record<string, unknown>;
  expect(paused.actions).toEqual(["resume", "extend_capacity", "terminate"]);
  expect((paused.pause as Record<string, unknown>).actions).toEqual(["resume", "extend_capacity", "terminate"]);

  const terminated = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/termination`, "POST", {
    idempotency_key: "termination_gates_terminate_001",
  });
  expect(terminated.status).toBe(200);

  const gated: ReadonlyArray<readonly [string, unknown, number, string]> = [
    [`/v1/ingestion-runs/${run.id}/collection/resume`, undefined, 409, "ingestion_run_not_collecting"],
    [
      `/v1/ingestion-runs/${run.id}/capacity/extension`,
      {
        expected_request_capacity: 5_000,
        expected_capacity_generation: 1,
        request_capacity: 6_000,
        idempotency_key: "termination_gates_extension_001",
      },
      409,
      "ingestion_run_not_paused",
    ],
    [
      `/v1/ingestion-runs/${run.id}/reconciliation`,
      {
        expected_current_revision_id: run.expected_current_revision_id,
        idempotency_key: "termination_gates_reconcile_001",
      },
      409,
      "run_not_active",
    ],
    [
      `/v1/ingestion-runs/${run.id}/approval`,
      {
        candidate_digest: "0".repeat(64),
        expected_current_revision_id: run.expected_current_revision_id,
        idempotency_key: "termination_gates_approval_001",
      },
      409,
      "run_not_awaiting_approval",
    ],
    [
      `/v1/ingestion-runs/${run.id}/retry`,
      { idempotency_key: "termination_gates_generic_retry_001" },
      409,
      "evidence_retry_required",
    ],
  ];
  for (const [pathname, body, status, code] of gated) {
    const response = await administrationRequest(pathname, "POST", body);
    const problem = await response.json<{ code?: string }>();
    expect({ pathname, status: response.status, code: problem.code }).toEqual({ pathname, status, code });
  }

  // The collection barrier and a replayed resume cannot move the terminal
  // run anywhere, and no capture work is admitted for its pending request.
  await finalizeEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  await resumePausedEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  const terminalRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  expect(terminalRun).toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
  });
  const pending = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (pending === undefined) throw new Error("pending request absent");
  await expect(prepareCaptureAttempt(catalogueStore(env.CATALOGUE_DB), terminalRun, pending)).resolves.toEqual({
    kind: "done",
    failure_code: null,
  });
  expect(
    await sourceEvidenceQueries.countSourceCaptureOperationsCount(env.CATALOGUE_DB).bind(run.id).first("count"),
  ).toBe(0);
  expect(
    await sourceEvidenceQueries
      .readSourceRequestsStateForHostnameWorkflowThatWakesTerminatedRunFinishesWithoutReloading(env.CATALOGUE_DB)
      .bind(run.id)
      .first("state"),
  ).toBe("pending");

  // The current Catalogue Revision is untouched, and a new Ingestion Run can
  // start now that the reservation is released.
  expect(await publishedCatalogueQueries.countCatalogueRevisionsCount(env.CATALOGUE_DB).first("count")).toEqual(
    revisionsBefore,
  );
  const successor = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "termination_gates_successor_001",
    requests: [{ id: "cards", url: "https://official-source.invalid/cards" }],
  });
  expect(successor.status).toBe(201);
  const successorRun = await successor.json<{ id: string }>();
  expect(successorRun.id).not.toBe(run.id);
  expect(
    await ingestionQueries.readOperationStateActiveIngestionRunId(env.CATALOGUE_DB).first("active_ingestion_run_id"),
  ).toBe(successorRun.id);

  // The terminated run's linked retry remains the sanctioned terminal path.
  const shown = (await showCollection(run.id)) as Record<string, unknown>;
  expect(shown.actions).toEqual(["retry"]);
  expect((shown.operational_diagnostics as { retry: { code: string } }).retry.code).toBe(
    "evidence_collection_retry_available",
  );
});

test("termination problems fail closed with explicit documents", async () => {
  const collecting = await createCollection(
    "termination_problems_collecting_001",
    "https://official-source.invalid/cards",
  );
  const notPaused = await administrationRequest(`/v1/ingestion-runs/${collecting.id}/collection/termination`, "POST", {
    idempotency_key: "termination_problems_not_paused_001",
  });
  expect(notPaused.status).toBe(409);
  await expect(notPaused.json()).resolves.toMatchObject({
    code: "ingestion_run_not_paused",
  });
  expect(await ingestionQueries.readIngestionRunsState(env.CATALOGUE_DB).bind(collecting.id).first("state")).toBe(
    "collecting",
  );

  const absent = await administrationRequest(
    "/v1/ingestion-runs/run_absent_000000000000/collection/termination",
    "POST",
    { idempotency_key: "termination_problems_absent_001" },
  );
  expect(absent.status).toBe(404);
  await expect(absent.json()).resolves.toMatchObject({
    code: "ingestion_evidence_not_found",
  });

  const unauthenticated = await exports.default.fetch(
    new Request(`https://card-keepr.invalid/v1/ingestion-runs/${collecting.id}/collection/termination`, {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.251",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: "termination_problems_unauthenticated_001",
      }),
    }),
  );
  expect(unauthenticated.status).toBe(401);
  await expect(unauthenticated.json()).resolves.toMatchObject({
    code: "authentication_required",
  });

  const missingKey = await administrationRequest(
    `/v1/ingestion-runs/${collecting.id}/collection/termination`,
    "POST",
    {},
  );
  expect(missingKey.status).toBe(422);
  expect(
    await sourceEvidenceQueries.countIngestionRunTerminationsCount(env.CATALOGUE_DB).bind(collecting.id).first("count"),
  ).toBe(0);

  // Reusing a termination key on a different run conflicts instead of
  // replaying or terminating.
  await clearActiveRunForNextScenario();
  const first = await createCollection("termination_problems_reuse_first_001", "https://official-source.invalid/cards");
  await pauseForWorkflowRecovery(first.id, "source_workflow_stalled");
  const terminated = await administrationRequest(`/v1/ingestion-runs/${first.id}/collection/termination`, "POST", {
    idempotency_key: "termination_problems_reused_key",
  });
  expect(terminated.status).toBe(200);
  await expect(terminated.json()).resolves.toMatchObject({
    pause_reason: "source_workflow_stalled",
  });
  const second = await createCollection(
    "termination_problems_reuse_second_001",
    "https://official-source.invalid/cards",
  );
  await pauseForWorkflowRecovery(second.id, "source_workflow_errored");
  const reused = await administrationRequest(`/v1/ingestion-runs/${second.id}/collection/termination`, "POST", {
    idempotency_key: "termination_problems_reused_key",
  });
  expect(reused.status).toBe(409);
  await expect(reused.json()).resolves.toMatchObject({
    code: "idempotency_conflict",
  });
  expect(await ingestionQueries.readIngestionRunsState(env.CATALOGUE_DB).bind(second.id).first("state")).toBe("paused");
});

test("concurrent terminations record exactly one owner decision", async () => {
  // Two terminations under different keys: one applies, one conflicts.
  const first = await createCollection("termination_race_terminate_001", "https://official-source.invalid/cards");
  await pauseForWorkflowRecovery(first.id, "source_workflow_stalled");
  const terminations = await Promise.all(
    [1, 2].map((writer) =>
      administrationRequest(`/v1/ingestion-runs/${first.id}/collection/termination`, "POST", {
        idempotency_key: `termination_race_terminate_writer_${writer}`,
      }),
    ),
  );
  expect(terminations.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(
    await sourceEvidenceQueries.countIngestionRunTerminationsCount(env.CATALOGUE_DB).bind(first.id).first("count"),
  ).toBe(1);
});

test("a resume dispatched before termination cannot revive the terminal run", async () => {
  const run = await createCollection("termination_delayed_resume_001", "https://official-source.invalid/cards");
  await pauseForWorkflowRecovery(run.id, "source_workflow_stalled");
  let notifyCreate!: (id: string) => void;
  let rejectCreate!: (error: unknown) => void;
  const reachedCreate = new Promise<string>((resolve, reject) => {
    notifyCreate = resolve;
    rejectCreate = reject;
  });
  let releaseCreate!: () => void;
  const creationReleased = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const delayedWorkflow = new Proxy(env.EVIDENCE_INGESTION_WORKFLOW, {
    get(target, property) {
      if (property === "create")
        return async (options: Parameters<typeof target.create>[0]) => {
          notifyCreate(options!.id!);
          await creationReleased;
          return target.create(options);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const resumed = resumeEvidenceRun(
    catalogueStore(env.CATALOGUE_DB),
    delayedWorkflow,
    run.id,
    env.EVIDENCE_HOST_WORKFLOW,
  );
  // Propagate an early admission failure instead of leaving the barrier waiting.
  void resumed.catch(rejectCreate);
  let workflowId: string;
  try {
    workflowId = await reachedCreate;
    expect(await ingestionQueries.readIngestionRunsState(env.CATALOGUE_DB).bind(run.id).first("state")).toBe(
      "collecting",
    );
    // Dispatch intent is durable, but the replacement instance does not exist
    // yet. Termination must observe that precise ordering on every run.
    const terminated = await terminateEvidenceCollection(
      catalogueStore(env.CATALOGUE_DB),
      env.EVIDENCE_INGESTION_WORKFLOW,
      env.EVIDENCE_HOST_WORKFLOW,
      run.id,
      "termination_delayed_resume_terminate",
    );
    expect(terminated).toMatchObject({ state: "failed", failure_code: "ingestion_run_terminated" });
  } finally {
    releaseCreate();
  }
  await expect(resumed).resolves.toMatchObject({ ingestion_run_id: run.id });
  // The real Workflow now starts after the terminal fence; wait for it to
  // settle so the assertion catches late writes, not just admission state.
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(workflowId);
  await waitForWorkflowStatus(workflowId, () => parent.status(), "complete", 12_000);
  expect(await ingestionQueries.readIngestionRunsStateFailureCode(env.CATALOGUE_DB).bind(run.id).first()).toEqual({
    state: "failed",
    failure_code: "ingestion_run_terminated",
  });
  expect(
    await sourceEvidenceQueries.countIngestionRunTerminationsCount(env.CATALOGUE_DB).bind(run.id).first("count"),
  ).toBe(1);
  const laterResume = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(laterResume.status).toBe(409);
  await expect(laterResume.json()).resolves.toMatchObject({ code: "ingestion_run_not_collecting" });
});

test("a capacity extension racing termination cannot revive the terminal run", async () => {
  // Terminate racing a capacity extension on a capacity-paused run: the
  // extension cannot apply to a terminated run and termination cannot apply
  // to a resumed one, so at most one generation and one termination exist.
  const third = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "termination_race_extension_001",
    requests: [{ id: "cards", url: "https://official-source.invalid/cards" }],
  });
  const thirdRun = await third.json<{ id: string }>();
  await pauseEvidenceRunForRequestCapacity(
    catalogueStore(env.CATALOGUE_DB),
    thirdRun.id,
    "cards",
    new RequestCapacityProblem({
      source_lineage: "one-piece-en",
      request_capacity: 5_000,
      capacity_generation: 1,
      used_capacity: 5_000,
      overflow_request_count: 1,
      required_capacity: 5_001,
    }),
  );
  const [terminateThird, extendThird] = await Promise.all([
    administrationRequest(`/v1/ingestion-runs/${thirdRun.id}/collection/termination`, "POST", {
      idempotency_key: "termination_race_extension_terminate",
    }),
    administrationRequest(`/v1/ingestion-runs/${thirdRun.id}/capacity/extension`, "POST", {
      expected_request_capacity: 5_000,
      expected_capacity_generation: 1,
      request_capacity: 6_000,
      idempotency_key: "termination_race_extension_extend",
    }),
  ]);
  expect(terminateThird.status).toBe(200);
  const extensions = await sourceEvidenceQueries
    .countIngestionRunCapacityExtensionsCount(env.CATALOGUE_DB)
    .bind(thirdRun.id)
    .first("count");
  // An extension that committed before termination is retained history; one
  // that lost the race reports the terminal state conflict.
  if (extendThird.status !== 200) {
    expect(extendThird.status).toBe(409);
    expect(extensions).toBe(0);
  } else {
    expect(extensions).toBe(1);
  }
  expect(await ingestionQueries.readIngestionRunsStateFailureCode(env.CATALOGUE_DB).bind(thirdRun.id).first()).toEqual({
    state: "failed",
    failure_code: "ingestion_run_terminated",
  });
});

test("terminating a transport-paused run fences its collection Workflows", async () => {
  const run = await createCollection(
    "termination_fence_001",
    "https://termination-fence-official-source.invalid/unavailable",
  );
  const started = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const paused = await waitForEvidenceCondition(run.id, (current) => current.state === "paused", 12_000);
  expect(paused.pause).toMatchObject({
    reason: "source_transport_retries_exhausted",
    actions: ["resume", "terminate"],
  });
  expect(paused.actions).toEqual(["resume", "terminate"]);

  const terminated = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/termination`, "POST", {
    idempotency_key: "termination_fence_terminate_001",
  });
  expect(terminated.status).toBe(200);
  await expect(terminated.json()).resolves.toMatchObject({
    pause_reason: "source_transport_retries_exhausted",
  });

  // Every recorded Workflow Attempt is settled: none keeps collecting.
  const parentId = `evidence-${run.id}`;
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId);
  await waitForWorkflowStatus(
    parentId,
    () => parent.status(),
    (await parent.status()).status === "complete" ? "complete" : "terminated",
    12_000,
  );
  const shown = await showCollection(run.id);
  for (const attempt of shown.workflow.attempts.filter((a) => a.kind === "child")) {
    const child = await env.EVIDENCE_HOST_WORKFLOW.get(attempt.id);
    expect(["complete", "terminated", "errored"]).toContain((await child.status()).status);
  }
  // The four retained failed attempts stay the whole append-only history:
  // no late step fetched again after termination.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(shown.diagnostics).toHaveLength(4);
  expect(await sourceEvidenceQueries.countSourceFetchAttemptsCount(env.CATALOGUE_DB).bind(run.id).first("count")).toBe(
    4,
  );
  expect(
    await sourceEvidenceQueries
      .readSourceRequestsStateFailureCodeForTerminatingTransportPausedRunFencesCollectionWorkflows(env.CATALOGUE_DB)
      .bind(run.id)
      .first(),
  ).toEqual({ state: "pending", failure_code: null });
  expect(shown).toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
    actions: ["retry"],
  });
  expect(shown.pause).toBeUndefined();
}, 60_000);
