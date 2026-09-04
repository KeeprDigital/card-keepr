import { catalogueStore } from "../../../src/catalogue/shared";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  parseCapturedRequest,
  prepareCaptureAttempt,
  finalizeEvidenceRun,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
import { administrationRequest, type CollectionDocument, installRuntimeSuite, showCollection } from "./runtime-helpers";
import { fusionWorldRequestCapacity, pauseRunAtCapacity } from "./capacity-pause-helpers";

installRuntimeSuite();

test("reaching request capacity pauses the Ingestion Run without failing retained work", async () => {
  // The retained discovery derives an overflow batch of stage requests that
  // no longer fits: admission is rejected all-or-nothing and the Ingestion
  // Run pauses instead of converting retained work into failures.
  const { runId, storedRun, root, snapshotId } = await pauseRunAtCapacity("request_capacity_pause_001");

  const pausedRun = await ingestionQueries
    .readIngestionRunsStateTerminalAtForReachingRequestCapacityPausesIngestionRunWithoutFailingRetained(
      env.CATALOGUE_DB,
    )
    .bind(runId)
    .first<{
      state: string;
      terminal_at: string | null;
      failure_code: string | null;
      progress_json: string;
    }>();
  expect(pausedRun).toMatchObject({
    state: "paused",
    terminal_at: null,
    failure_code: null,
  });
  expect(JSON.parse(pausedRun?.progress_json ?? "{}")).toEqual({
    completed_stages: ["planning"],
    current_stage: "paused",
  });

  // No request was failed, the parent stays captured with its retained
  // Source Snapshot, and no part of the overflow batch was admitted.
  expect(
    await sourceEvidenceQueries
      .countSourceRequestsCountForReachingRequestCapacityPausesIngestionRunWithoutFailingRetained(env.CATALOGUE_DB)
      .bind(runId)
      .first("count"),
  ).toBe(0);
  expect(
    await sourceEvidenceQueries
      .readSourceRequestsStateSourceSnapshotId(env.CATALOGUE_DB)
      .bind(runId, root.request_id)
      .first(),
  ).toMatchObject({
    state: "captured",
    source_snapshot_id: snapshotId,
  });
  expect(await sourceEvidenceQueries.countSourceRequestsCount(env.CATALOGUE_DB).bind(runId).first("count")).toBe(
    fusionWorldRequestCapacity,
  );

  // The pause facts are persisted for capacity extension and inspection.
  const pause = await sourceEvidenceQueries
    .readIngestionRunCapacityPauses(env.CATALOGUE_DB)
    .bind(runId)
    .first<Record<string, unknown>>();
  expect(pause).toMatchObject({
    pause_reason: "source_request_capacity_exhausted",
    source_lineage: "fusion-world-en",
    parent_request_id: root.request_id,
    request_capacity: fusionWorldRequestCapacity,
    capacity_generation: 1,
    used_capacity: fusionWorldRequestCapacity,
  });
  const overflow = Number(pause?.overflow_request_count);
  expect(overflow).toBeGreaterThanOrEqual(1);
  expect(pause?.required_capacity).toBe(fusionWorldRequestCapacity + overflow);
  expect(typeof pause?.paused_at).toBe("string");

  // The pause is a recorded lifecycle transition, not a terminal outcome.
  expect(
    await ingestionQueries.readIngestionRunTransitionsFromStateToState(env.CATALOGUE_DB).bind(runId).first(),
  ).toMatchObject({
    from_state: "collecting",
    to_state: "paused",
  });

  // The paused run retains the single active-run reservation, so another
  // Ingestion Run cannot start while it holds retained work.
  expect(
    await ingestionQueries.readOperationStateActiveIngestionRunId(env.CATALOGUE_DB).first("active_ingestion_run_id"),
  ).toBe(runId);
  const competing = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "request_capacity_pause_competitor_001",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(competing.status).toBe(409);
  expect(await competing.json()).toMatchObject({ code: "active_ingestion_run" });

  // The collection barrier cannot finalize a paused run into any other state.
  await finalizeEvidenceRun(catalogueStore(env.CATALOGUE_DB), runId);
  expect(await ingestionQueries.readIngestionRunsState(env.CATALOGUE_DB).bind(runId).first("state")).toBe("paused");

  // Replaying the durable parse step is idempotent: still paused, still one
  // immutable pause record.
  await expect(
    parseCapturedRequest(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, storedRun, root, snapshotId),
  ).resolves.toMatchObject({ kind: "done", failure_code: null });
  expect(
    await sourceEvidenceQueries.countIngestionRunCapacityPausesCount(env.CATALOGUE_DB).bind(runId).first("count"),
  ).toBe(1);

  // The authenticated evidence status document reports the pause and the
  // minimum capacity facts needed to choose a meaningful extension.
  const document = (await showCollection(runId)) as CollectionDocument & {
    pause?: Record<string, unknown>;
  };
  expect(document.state).toBe("paused");
  expect(document.failure_code).toBeNull();
  // The retained discovery evidence that derives the overflow batch again
  // survives the pause: the captured Source Snapshot and its parsed Source
  // Observation Set remain in the document unchanged.
  expect(document.snapshots.map(({ id }) => id)).toContain(snapshotId);
  expect(document.observation_sets.length).toBeGreaterThanOrEqual(1);
  // The pause block has a closed shape: correlation identifiers and capacity
  // numbers only, so the diagnostics surface stays free of payloads and
  // credentials.
  expect(document.pause).toEqual({
    reason: "source_request_capacity_exhausted",
    paused_at: pause?.paused_at,
    source_lineage: "fusion-world-en",
    parent_request_id: root.request_id,
    request_capacity: fusionWorldRequestCapacity,
    capacity_generation: 1,
    used_capacity: fusionWorldRequestCapacity,
    overflow_request_count: overflow,
    required_capacity: fusionWorldRequestCapacity + overflow,
    actions: ["resume", "extend_capacity", "terminate"],
  });
  expect(document.actions).toEqual(["resume", "extend_capacity", "terminate"]);
}, 30_000);

test("a paused Ingestion Run fails closed on every advancing operation", async () => {
  const { runId } = await pauseRunAtCapacity("request_capacity_pause_gates_001");
  const pausedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), runId);
  expect(pausedRun.state).toBe("paused");

  // No further capture or parse work is admitted while paused.
  const pending = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), runId)).find(
    (row) => row.state === "pending",
  );
  if (pending === undefined) throw new Error("pending filler request absent");
  await expect(prepareCaptureAttempt(catalogueStore(env.CATALOGUE_DB), pausedRun, pending)).resolves.toEqual({
    kind: "done",
    failure_code: null,
  });
  expect(
    await sourceEvidenceQueries
      .countSourceCaptureOperationsCountForPausedIngestionRunFailsClosedOnEveryAdvancingOperation(env.CATALOGUE_DB)
      .bind(runId, pending.request_id)
      .first("count"),
  ).toBe(0);

  // Reconciliation, evidence retry, approval, candidate rejection, and the
  // generic retry interface all refuse a paused run. Collection resume is
  // deliberately absent: issue #65 made it the single sanctioned exit from a
  // Capacity Pause, covered by runtime-capacity-resume.spec.ts.
  const gated: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      `/v1/ingestion-runs/${runId}/reconciliation`,
      {
        expected_current_revision_id: pausedRun.expected_current_revision_id,
        idempotency_key: "paused_gate_reconcile_001",
      },
      "run_not_active",
    ],
    [
      `/v1/ingestion-runs/${runId}/collection/retry`,
      { idempotency_key: "paused_gate_evidence_retry_001" },
      "ingestion_run_not_retryable",
    ],
    [
      `/v1/ingestion-runs/${runId}/approval`,
      {
        candidate_digest: "0".repeat(64),
        expected_current_revision_id: pausedRun.expected_current_revision_id,
        idempotency_key: "paused_gate_approval_001",
      },
      "run_not_awaiting_approval",
    ],
    [
      `/v1/ingestion-runs/${runId}/rejection`,
      {
        candidate_digest: "0".repeat(64),
        idempotency_key: "paused_gate_rejection_001",
      },
      "run_not_awaiting_approval",
    ],
    [`/v1/ingestion-runs/${runId}/retry`, { idempotency_key: "paused_gate_retry_001" }, "source_run_not_terminal"],
  ];
  for (const [pathname, body, code] of gated) {
    const response = await administrationRequest(pathname, "POST", body);
    const problem = await response.json<{ code?: string }>();
    expect({ pathname, status: response.status, code: problem.code }).toEqual({ pathname, status: 409, code });
  }
  const candidate = await administrationRequest(`/v1/ingestion-runs/${runId}/candidate`, "GET");
  expect(candidate.status).toBe(409);
  expect(await candidate.json()).toMatchObject({
    code: "candidate_not_approvable",
  });

  // None of the refused operations disturbed the paused run, its retained
  // requests, or the single active-run reservation.
  expect(await ingestionQueries.readIngestionRunsStateTerminalAt(env.CATALOGUE_DB).bind(runId).first()).toMatchObject({
    state: "paused",
    terminal_at: null,
    failure_code: null,
  });
  expect(
    await sourceEvidenceQueries
      .countSourceRequestsCountForReachingRequestCapacityPausesIngestionRunWithoutFailingRetained(env.CATALOGUE_DB)
      .bind(runId)
      .first("count"),
  ).toBe(0);
  expect(
    await ingestionQueries.readOperationStateActiveIngestionRunId(env.CATALOGUE_DB).first("active_ingestion_run_id"),
  ).toBe(runId);
}, 30_000);
