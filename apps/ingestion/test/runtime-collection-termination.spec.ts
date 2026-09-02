import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  prepareCaptureAttempt,
} from "../../../src/catalogue/source-evidence-capture";
import {
  finalizeEvidenceRun,
  pauseEvidenceRunForRequestCapacity,
  pauseEvidenceRunForWorkflowRecovery,
  pendingEvidenceRequests,
  RequestCapacityProblem,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  administrationRequest,
  clearActiveRunForNextScenario,
  createCollection,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceCondition,
  waitForEvidenceRun,
  waitForWorkflowStatus,
} from "./runtime-helpers";
import { pauseRunAtCapacity } from "./capacity-pause-helpers";

installRuntimeSuite();

async function pauseForWorkflowRecovery(
  runId: string,
  reason: "source_workflow_stalled" | "source_workflow_errored",
): Promise<void> {
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
     WHERE ingestion_run_id = ?`,
  ).bind(`evidence-${runId}`, runId).run();
  await pauseEvidenceRunForWorkflowRecovery(env.CATALOGUE_DB, runId, {
    workflow_instance_id: `evidence-${runId}`,
    pause_reason: reason,
    workflow_status: reason === "source_workflow_errored" ? "errored" : "running",
    last_progress_at: null,
  });
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state FROM ingestion_runs WHERE id = ?",
  ).bind(runId).first("state")).toBe("paused");
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
async function retainedEvidenceCounts(
  runId: string,
): Promise<RetainedEvidenceCounts> {
  const count = (sql: string) =>
    env.CATALOGUE_DB.prepare(sql).bind(runId).first("count");
  return {
    snapshots: await count(
      "SELECT COUNT(*) AS count FROM source_snapshots WHERE ingestion_run_id = ?",
    ),
    observation_sets: await count(
      `SELECT COUNT(*) AS count FROM source_observation_sets
       WHERE source_snapshot_id IN (
         SELECT id FROM source_snapshots WHERE ingestion_run_id = ?
       )`,
    ),
    fetch_attempts: await count(
      "SELECT COUNT(*) AS count FROM source_fetch_attempts WHERE ingestion_run_id = ?",
    ),
    discovery_plans: await count(
      "SELECT COUNT(*) AS count FROM source_discovery_request_plans WHERE ingestion_run_id = ?",
    ),
    capacity_pauses: await count(
      "SELECT COUNT(*) AS count FROM ingestion_run_capacity_pauses WHERE ingestion_run_id = ?",
    ),
    requests_by_state: (await env.CATALOGUE_DB.prepare(
      `SELECT state, COUNT(*) AS count FROM source_requests
       WHERE ingestion_run_id = ? GROUP BY state ORDER BY state`,
    ).bind(runId).all<{ state: string; count: number }>()).results,
  };
}

test("terminating a paused run records the owner decision, releases the reservation, and retains all evidence", async () => {
  const { runId, snapshotId } = await pauseRunAtCapacity(
    "termination_capacity_001",
    "observed",
  );
  const before = await retainedEvidenceCounts(runId);
  expect(before.snapshots).toBe(1);
  expect(before.observation_sets).toBe(1);

  const terminated = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/termination`,
    "POST",
    { idempotency_key: "termination_001" },
  );
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
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state, terminal_at, failure_code FROM ingestion_runs WHERE id = ?",
  ).bind(runId).first()).toEqual({
    state: "failed",
    terminal_at: document.terminated_at,
    failure_code: "ingestion_run_terminated",
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT from_state, to_state FROM ingestion_run_transitions
     WHERE ingestion_run_id = ? ORDER BY sequence DESC LIMIT 1`,
  ).bind(runId).first()).toEqual({ from_state: "paused", to_state: "failed" });
  const record = await env.CATALOGUE_DB.prepare(
    "SELECT * FROM ingestion_run_terminations WHERE ingestion_run_id = ?",
  ).bind(runId).first<Record<string, unknown>>();
  expect(record).toMatchObject({
    pause_reason: "source_request_capacity_exhausted",
    paused_at: document.paused_at,
    terminated_at: document.terminated_at,
    idempotency_key: "termination_001",
  });
  await expect(env.CATALOGUE_DB.prepare(
    "UPDATE ingestion_run_terminations SET terminated_at = '2099-01-01T00:00:00.000Z'",
  ).run()).rejects.toThrowError(/termination_immutable/u);
  await expect(env.CATALOGUE_DB.prepare(
    "DELETE FROM ingestion_run_terminations",
  ).run()).rejects.toThrowError(/termination_immutable/u);

  // The single active-run reservation is released.
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1",
  ).first("active_ingestion_run_id")).toBeNull();

  // No retained evidence object was deleted or re-stated.
  expect(await retainedEvidenceCounts(runId)).toEqual(before);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT state, source_snapshot_id FROM source_requests
     WHERE ingestion_run_id = ? AND source_snapshot_id = ?`,
  ).bind(runId, snapshotId).first()).toEqual({
    state: "captured",
    source_snapshot_id: snapshotId,
  });

  // Replaying the same termination returns the original result; a second
  // termination under a different key is a state conflict.
  const replayed = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/termination`,
    "POST",
    { idempotency_key: "termination_001" },
  );
  expect(replayed.status).toBe(200);
  await expect(replayed.json()).resolves.toEqual(document);
  const again = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/termination`,
    "POST",
    { idempotency_key: "termination_002" },
  );
  expect(again.status).toBe(409);
  await expect(again.json()).resolves.toMatchObject({
    code: "ingestion_run_not_paused",
  });

  // Inspection reports the terminal owner decision and advertises neither
  // resume nor capacity extension.
  const shown = await showCollection(runId) as Record<string, unknown>;
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
  expect(
    (shown.snapshots as Array<{ id: string }>).map(({ id }) => id),
  ).toEqual([snapshotId]);
}, 60_000);

test("a terminated run refuses every lifecycle continuation and frees the reservation for a new run", async () => {
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "termination_gates_001",
    requests: [
      { id: "cards", url: "https://official-source.invalid/cards" },
    ],
  });
  expect(created.status).toBe(201);
  const run = await created.json<{
    id: string;
    expected_current_revision_id: string;
  }>();
  const revisionsBefore = await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM catalogue_revisions",
  ).first("count");
  await pauseEvidenceRunForRequestCapacity(
    env.CATALOGUE_DB,
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
  const paused = await showCollection(run.id) as Record<string, unknown>;
  expect(paused.actions).toEqual(["resume", "extend_capacity", "terminate"]);
  expect((paused.pause as Record<string, unknown>).actions)
    .toEqual(["resume", "extend_capacity", "terminate"]);

  const terminated = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/termination`,
    "POST",
    { idempotency_key: "termination_gates_terminate_001" },
  );
  expect(terminated.status).toBe(200);

  const gated: ReadonlyArray<readonly [string, unknown, number, string]> = [
    [
      `/v1/ingestion-runs/${run.id}/collection/resume`,
      undefined,
      409,
      "ingestion_run_not_collecting",
    ],
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
    expect({ pathname, status: response.status, code: problem.code })
      .toEqual({ pathname, status, code });
  }

  // The collection barrier and a replayed resume cannot move the terminal
  // run anywhere, and no capture work is admitted for its pending request.
  await finalizeEvidenceRun(env.CATALOGUE_DB, run.id);
  await resumePausedEvidenceRun(env.CATALOGUE_DB, run.id);
  const terminalRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  expect(terminalRun).toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
  });
  const pending = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (pending === undefined) throw new Error("pending request absent");
  await expect(prepareCaptureAttempt(
    env.CATALOGUE_DB,
    terminalRun,
    pending,
  )).resolves.toEqual({ kind: "done", failure_code: null });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_capture_operations
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(0);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT state FROM source_requests WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("state")).toBe("pending");

  // The current Catalogue Revision is untouched, and a new Ingestion Run can
  // start now that the reservation is released.
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM catalogue_revisions",
  ).first("count")).toEqual(revisionsBefore);
  const successor = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "termination_gates_successor_001",
    requests: [
      { id: "cards", url: "https://official-source.invalid/cards" },
    ],
  });
  expect(successor.status).toBe(201);
  const successorRun = await successor.json<{ id: string }>();
  expect(successorRun.id).not.toBe(run.id);
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1",
  ).first("active_ingestion_run_id")).toBe(successorRun.id);

  // The terminated run's linked retry remains the sanctioned terminal path.
  const shown = await showCollection(run.id) as Record<string, unknown>;
  expect(shown.actions).toEqual(["retry"]);
  expect(
    (shown.operational_diagnostics as { retry: { code: string } }).retry.code,
  ).toBe("evidence_collection_retry_available");
});

test("termination problems fail closed with explicit documents", async () => {
  const collecting = await createCollection(
    "termination_problems_collecting_001",
    "https://official-source.invalid/cards",
  );
  const notPaused = await administrationRequest(
    `/v1/ingestion-runs/${collecting.id}/collection/termination`,
    "POST",
    { idempotency_key: "termination_problems_not_paused_001" },
  );
  expect(notPaused.status).toBe(409);
  await expect(notPaused.json()).resolves.toMatchObject({
    code: "ingestion_run_not_paused",
  });
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state FROM ingestion_runs WHERE id = ?",
  ).bind(collecting.id).first("state")).toBe("collecting");

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
    new Request(
      `https://card-keepr.invalid/v1/ingestion-runs/${collecting.id}/collection/termination`,
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "192.0.2.251",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: "termination_problems_unauthenticated_001",
        }),
      },
    ),
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
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM ingestion_run_terminations WHERE ingestion_run_id = ?",
  ).bind(collecting.id).first("count")).toBe(0);

  // Reusing a termination key on a different run conflicts instead of
  // replaying or terminating.
  await clearActiveRunForNextScenario();
  const first = await createCollection(
    "termination_problems_reuse_first_001",
    "https://official-source.invalid/cards",
  );
  await pauseForWorkflowRecovery(first.id, "source_workflow_stalled");
  const terminated = await administrationRequest(
    `/v1/ingestion-runs/${first.id}/collection/termination`,
    "POST",
    { idempotency_key: "termination_problems_reused_key" },
  );
  expect(terminated.status).toBe(200);
  await expect(terminated.json()).resolves.toMatchObject({
    pause_reason: "source_workflow_stalled",
  });
  const second = await createCollection(
    "termination_problems_reuse_second_001",
    "https://official-source.invalid/cards",
  );
  await pauseForWorkflowRecovery(second.id, "source_workflow_errored");
  const reused = await administrationRequest(
    `/v1/ingestion-runs/${second.id}/collection/termination`,
    "POST",
    { idempotency_key: "termination_problems_reused_key" },
  );
  expect(reused.status).toBe(409);
  await expect(reused.json()).resolves.toMatchObject({
    code: "idempotency_conflict",
  });
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state FROM ingestion_runs WHERE id = ?",
  ).bind(second.id).first("state")).toBe("paused");
});

test("concurrent terminate, resume, and extension requests resolve to exactly one outcome", async () => {
  // Two terminations under different keys: one applies, one conflicts.
  const first = await createCollection(
    "termination_race_terminate_001",
    "https://official-source.invalid/cards",
  );
  await pauseForWorkflowRecovery(first.id, "source_workflow_stalled");
  const terminations = await Promise.all([1, 2].map((writer) =>
    administrationRequest(
      `/v1/ingestion-runs/${first.id}/collection/termination`,
      "POST",
      { idempotency_key: `termination_race_terminate_writer_${writer}` },
    )
  ));
  expect(terminations.map((response) => response.status).sort())
    .toEqual([200, 409]);
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM ingestion_run_terminations WHERE ingestion_run_id = ?",
  ).bind(first.id).first("count")).toBe(1);
  await clearActiveRunForNextScenario();

  // Terminate racing resume: whichever wins, the run has exactly one
  // outcome and the loser reports a state conflict.
  const second = await createCollection(
    "termination_race_resume_001",
    "https://official-source.invalid/cards",
  );
  await pauseEvidenceRunForWorkflowRecovery(env.CATALOGUE_DB, second.id, {
    workflow_instance_id: `evidence-${second.id}`,
    pause_reason: "source_workflow_stalled",
    workflow_status: "running",
    last_progress_at: null,
  });
  const [terminateOutcome, resumeOutcome] = await Promise.all([
    administrationRequest(
      `/v1/ingestion-runs/${second.id}/collection/termination`,
      "POST",
      { idempotency_key: "termination_race_resume_terminate" },
    ),
    administrationRequest(
      `/v1/ingestion-runs/${second.id}/collection/resume`,
      "POST",
    ),
  ]);
  const state = await env.CATALOGUE_DB.prepare(
    "SELECT state FROM ingestion_runs WHERE id = ?",
  ).bind(second.id).first("state");
  if (terminateOutcome.status === 200) {
    expect(state).toBe("failed");
    expect(resumeOutcome.status).toBe(409);
    await expect(resumeOutcome.json()).resolves.toMatchObject({
      code: "ingestion_run_not_collecting",
    });
  } else {
    expect(resumeOutcome.status).toBe(202);
    expect(state).toBe("collecting");
    expect(terminateOutcome.status).toBe(409);
    await expect(terminateOutcome.json()).resolves.toMatchObject({
      code: "ingestion_run_not_paused",
    });
    await waitForEvidenceRun(second.id, "parsing", 20_000);
  }
  await clearActiveRunForNextScenario();

  // Terminate racing a capacity extension on a capacity-paused run: the
  // extension cannot apply to a terminated run and termination cannot apply
  // to a resumed one, so at most one generation and one termination exist.
  const third = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "termination_race_extension_001",
    requests: [
      { id: "cards", url: "https://official-source.invalid/cards" },
    ],
  });
  const thirdRun = await third.json<{ id: string }>();
  await pauseEvidenceRunForRequestCapacity(
    env.CATALOGUE_DB,
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
    administrationRequest(
      `/v1/ingestion-runs/${thirdRun.id}/collection/termination`,
      "POST",
      { idempotency_key: "termination_race_extension_terminate" },
    ),
    administrationRequest(
      `/v1/ingestion-runs/${thirdRun.id}/capacity/extension`,
      "POST",
      {
        expected_request_capacity: 5_000,
        expected_capacity_generation: 1,
        request_capacity: 6_000,
        idempotency_key: "termination_race_extension_extend",
      },
    ),
  ]);
  expect(terminateThird.status).toBe(200);
  const extensions = await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM ingestion_run_capacity_extensions WHERE ingestion_run_id = ?",
  ).bind(thirdRun.id).first("count");
  // An extension that committed before termination is retained history; one
  // that lost the race reports the terminal state conflict.
  if (extendThird.status !== 200) {
    expect(extendThird.status).toBe(409);
    expect(extensions).toBe(0);
  } else {
    expect(extensions).toBe(1);
  }
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state, failure_code FROM ingestion_runs WHERE id = ?",
  ).bind(thirdRun.id).first()).toEqual({
    state: "failed",
    failure_code: "ingestion_run_terminated",
  });
}, 60_000);

test("terminating a transport-paused run fences its collection Workflows", async () => {
  const run = await createCollection(
    "termination_fence_001",
    "https://termination-fence-official-source.invalid/unavailable",
  );
  const started = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const paused = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "paused",
    12_000,
  );
  expect(paused.pause).toMatchObject({
    reason: "source_transport_retries_exhausted",
    actions: ["resume", "terminate"],
  });
  expect(paused.actions).toEqual(["resume", "terminate"]);

  const terminated = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/termination`,
    "POST",
    { idempotency_key: "termination_fence_terminate_001" },
  );
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
    expect(["complete", "terminated", "errored"]).toContain(
      (await child.status()).status,
    );
  }
  // The four retained failed attempts stay the whole append-only history:
  // no late step fetched again after termination.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(shown.diagnostics).toHaveLength(4);
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM source_fetch_attempts WHERE ingestion_run_id = ?",
  ).bind(run.id).first("count")).toBe(4);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT state, failure_code FROM source_requests WHERE ingestion_run_id = ?`,
  ).bind(run.id).first()).toEqual({ state: "pending", failure_code: null });
  expect(shown).toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
    actions: ["retry"],
  });
  expect(shown.pause).toBeUndefined();
}, 60_000);
