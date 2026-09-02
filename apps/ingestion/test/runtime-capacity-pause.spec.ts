import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  parseCapturedRequest,
  prepareCaptureAttempt,
} from "../../../src/catalogue/source-evidence-capture";
import {
  finalizeEvidenceRun,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/product-release-source-adapters";
import { sha256, utf8 } from "../../../src/catalogue/serialization";
import retainedFusionWorldDiscovery from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-restructured-card-search.json";
import {
  administrationRequest,
  type CollectionDocument,
  installRuntimeSuite,
  showCollection,
} from "./runtime-helpers";

installRuntimeSuite();

const fusionWorldRequestCapacity = 15_000;

// Retain one captured Official Source response so the capture path can parse
// it without a live publisher fetch, leaving the Source Request 'captured'
// exactly as the hostname Workflow shards do before their parse step.
async function retainCapturedDiscoveryRoot(
  runId: string,
  requestId: string,
  url: string,
  bytes: Uint8Array,
): Promise<string> {
  const digest = await sha256(bytes);
  // Identities are scoped to the run: D1 state persists across the tests in
  // this file and both scenarios retain the same discovery bytes.
  const identity = await sha256(utf8(`${runId}:${digest}`));
  const snapshotId = `srcsnap_${identity}`;
  const fetchId = `srcfetch_${identity}`;
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  await env.EVIDENCE_OBJECTS.put(objectKey, bytes);
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      `INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES (?, ?, ?, 1, '2026-08-07T00:00:00.000Z',
         '2026-08-07T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`,
    ).bind(fetchId, runId, requestId),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO source_snapshots (
         id, ingestion_run_id, request_id, fetch_attempt_id,
         request_method, request_url, request_headers_json,
         representation_fingerprint, response_vary_json, retrieved_at,
         http_status, response_headers_json, media_type, content_digest,
         content_byte_length, content_object_key, source_lineage,
         supported_game, game_profile_version, adapter_version,
         reused_source_snapshot_id
       ) VALUES (?, ?, ?, ?, 'GET', ?, ?, ?, '[]',
         '2026-08-07T00:00:01.000Z', 200, '{}', 'text/html', ?, ?, ?,
         'fusion-world-en', 'fusion-world', 'fusion-world@1',
         'fusion-world-en@9', NULL)`,
    ).bind(
      snapshotId,
      runId,
      requestId,
      fetchId,
      url,
      JSON.stringify({ accept: "text/html" }),
      digest,
      digest,
      bytes.byteLength,
      objectKey,
    ),
    env.CATALOGUE_DB.prepare(
      `UPDATE source_requests SET state = 'captured', source_snapshot_id = ?
       WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`,
    ).bind(snapshotId, runId, requestId),
  ]);
  return snapshotId;
}

// Fill the Source Lineage with retained unique request identities so the
// discovery root is the capacity-th identity. The immutable-plan trigger
// admits a source_requests row only through a matching retained discovery
// plan row, so retain those first.
async function fillLineageToCapacity(
  runId: string,
  parentRequestId: string,
): Promise<void> {
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      `WITH RECURSIVE filler(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < ?2
       )
       INSERT INTO source_discovery_request_plans (
         ingestion_run_id, request_id, sequence_number, parent_request_id,
         method, url, request_headers_json, representation_fingerprint,
         request_role
       )
       SELECT ?1, 'fusion-world-en:detail:' || printf('%08d', n), 1000 + n,
              ?3, 'GET',
              'https://www.dbs-cardgame.com/fw/en/cardlist/detail/' || n,
              '{}', printf('%064x', n), 'detail'
       FROM filler`,
    ).bind(runId, fusionWorldRequestCapacity - 1, parentRequestId),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id, failure_code, request_role,
         discovered_from_request_id
       )
       SELECT ingestion_run_id, request_id, sequence_number, method, url,
              request_headers_json, representation_fingerprint, 'pending',
              NULL, NULL, request_role, parent_request_id
       FROM source_discovery_request_plans
       WHERE ingestion_run_id = ?1
         AND request_id LIKE 'fusion-world-en:detail:%'`,
    ).bind(runId),
  ]);
}

// Stage a fusion-world-en@9 run whose Source Lineage already holds exactly
// its request capacity, then parse the retained captured discovery root so
// the derived overflow batch is rejected and the run pauses.
async function pauseRunAtCapacity(idempotencyKey: string) {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@9",
      idempotency_key: idempotencyKey,
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<{ id: string }>();
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("discovery root request is absent");
  await fillLineageToCapacity(run.id, root.request_id);
  const snapshotId = await retainCapturedDiscoveryRoot(
    run.id,
    root.request_id,
    root.url,
    Buffer.from(retainedFusionWorldDiscovery.body_base64, "base64"),
  );
  await expect(parseCapturedRequest(
    env.CATALOGUE_DB,
    env.EVIDENCE_OBJECTS,
    storedRun,
    root,
    snapshotId,
  )).resolves.toMatchObject({ kind: "done", failure_code: null });
  return { runId: run.id, storedRun, root, snapshotId };
}

test("reaching request capacity pauses the Ingestion Run without failing retained work", async () => {
  // The retained discovery derives an overflow batch of stage requests that
  // no longer fits: admission is rejected all-or-nothing and the Ingestion
  // Run pauses instead of converting retained work into failures.
  const { runId, storedRun, root, snapshotId } = await pauseRunAtCapacity(
    "request_capacity_pause_001",
  );

  const pausedRun = await env.CATALOGUE_DB.prepare(
    `SELECT state, terminal_at, failure_code, progress_json
     FROM ingestion_runs WHERE id = ?`,
  ).bind(runId).first<{
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
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ? AND state = 'failed'`,
  ).bind(runId).first("count")).toBe(0);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT state, source_snapshot_id FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = ?`,
  ).bind(runId, root.request_id).first()).toMatchObject({
    state: "captured",
    source_snapshot_id: snapshotId,
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first("count")).toBe(fusionWorldRequestCapacity);

  // The pause facts are persisted for capacity extension and inspection.
  const pause = await env.CATALOGUE_DB.prepare(
    `SELECT * FROM ingestion_run_capacity_pauses WHERE ingestion_run_id = ?`,
  ).bind(runId).first<Record<string, unknown>>();
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
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT from_state, to_state FROM ingestion_run_transitions
     WHERE ingestion_run_id = ? ORDER BY sequence DESC LIMIT 1`,
  ).bind(runId).first()).toMatchObject({
    from_state: "collecting",
    to_state: "paused",
  });

  // The paused run retains the single active-run reservation, so another
  // Ingestion Run cannot start while it holds retained work.
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1`,
  ).first("active_ingestion_run_id")).toBe(runId);
  const competing = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@9",
      idempotency_key: "request_capacity_pause_competitor_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    },
  );
  expect(competing.status).toBe(409);
  expect(await competing.json()).toMatchObject({ code: "active_ingestion_run" });

  // The collection barrier cannot finalize a paused run into any other state.
  await finalizeEvidenceRun(env.CATALOGUE_DB, runId);
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state FROM ingestion_runs WHERE id = ?",
  ).bind(runId).first("state")).toBe("paused");

  // Replaying the durable parse step is idempotent: still paused, still one
  // immutable pause record.
  await expect(parseCapturedRequest(
    env.CATALOGUE_DB,
    env.EVIDENCE_OBJECTS,
    storedRun,
    root,
    snapshotId,
  )).resolves.toMatchObject({ kind: "done", failure_code: null });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_capacity_pauses
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first("count")).toBe(1);

  // The authenticated evidence status document reports the pause and the
  // minimum capacity facts needed to choose a meaningful extension.
  const document = await showCollection(runId) as CollectionDocument & {
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
  });
}, 30_000);

test("a paused Ingestion Run fails closed on every advancing operation", async () => {
  const { runId } = await pauseRunAtCapacity("request_capacity_pause_gates_001");
  const pausedRun = await requiredEvidenceRun(env.CATALOGUE_DB, runId);
  expect(pausedRun.state).toBe("paused");

  // No further capture or parse work is admitted while paused.
  const pending = (await pendingEvidenceRequests(env.CATALOGUE_DB, runId))
    .find((row) => row.state === "pending");
  if (pending === undefined) throw new Error("pending filler request absent");
  await expect(prepareCaptureAttempt(
    env.CATALOGUE_DB,
    pausedRun,
    pending,
  )).resolves.toEqual({ kind: "done", failure_code: null });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_capture_operations
     WHERE ingestion_run_id = ? AND request_id = ?`,
  ).bind(runId, pending.request_id).first("count")).toBe(0);

  // Reconciliation, resume, evidence retry, approval, candidate rejection,
  // and the generic retry interface all refuse a paused run.
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
      `/v1/ingestion-runs/${runId}/collection/resume`,
      undefined,
      "ingestion_run_not_collecting",
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
    [
      `/v1/ingestion-runs/${runId}/retry`,
      { idempotency_key: "paused_gate_retry_001" },
      "source_run_not_terminal",
    ],
  ];
  for (const [pathname, body, code] of gated) {
    const response = await administrationRequest(pathname, "POST", body);
    const problem = await response.json<{ code?: string }>();
    expect({ pathname, status: response.status, code: problem.code })
      .toEqual({ pathname, status: 409, code });
  }
  const candidate = await administrationRequest(
    `/v1/ingestion-runs/${runId}/candidate`,
    "GET",
  );
  expect(candidate.status).toBe(409);
  expect(await candidate.json()).toMatchObject({
    code: "candidate_not_approvable",
  });

  // None of the refused operations disturbed the paused run, its retained
  // requests, or the single active-run reservation.
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state, terminal_at, failure_code FROM ingestion_runs WHERE id = ?",
  ).bind(runId).first()).toMatchObject({
    state: "paused",
    terminal_at: null,
    failure_code: null,
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ? AND state = 'failed'`,
  ).bind(runId).first("count")).toBe(0);
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1",
  ).first("active_ingestion_run_id")).toBe(runId);
}, 30_000);
