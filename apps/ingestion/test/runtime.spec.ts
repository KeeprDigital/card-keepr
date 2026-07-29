import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import { fixtureCandidate } from "../../../src/catalogue/fixture";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};
let requestSequence = 0;
let testObservedAt: string | null = null;

beforeEach(async () => {
  testObservedAt = null;
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

afterEach(async () => {
  const status = await administrationRequest("/v1/status");
  const active = status.document.active_ingestion_run;
  if (
    active !== null &&
    typeof active === "object" &&
    "id" in active &&
    typeof active.id === "string" &&
    "candidate_digest" in active &&
    typeof active.candidate_digest === "string"
  ) {
    await administrationRequest(
      `/v1/ingestion-runs/${active.id}/rejection`,
      {
        candidate_digest: active.candidate_digest,
        idempotency_key: `cleanup-${crypto.randomUUID()}`,
      },
    );
  }
});

test("the administration authentication boundary runs in the Workers runtime", async () => {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: "Bearer vitest-administration-key" },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "ingestion",
    status: "ok",
  });
});

test("a lengthless administration body is rejected while streaming beyond 16 KiB", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls > 2) {
          controller.error(
            new Error("the Worker read beyond the bounded prefix"),
          );
          return;
        }
        controller.enqueue(new Uint8Array(10_000));
      },
    },
    { highWaterMark: 0 },
  );
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/ingestion-runs", {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.251",
      },
      body,
    }),
  );
  expect(response.status).toBe(413);
  await expect(response.json()).resolves.toMatchObject({
    code: "request_too_large",
  });
  expect(pulls).toBe(2);
});

test("competing starts fail closed while an identical retry replays its original result", async () => {
  const started = await administrationRequest("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "start-first",
  });

  expect(started.response.status).toBe(201);
  expect(started.document).toMatchObject({
    state: "awaiting_approval",
    progress: {
      completed_stages: [
        "planning",
        "collecting",
        "parsing",
        "reconciling",
      ],
      current_stage: "awaiting_approval",
    },
    warnings: [],
    failure_code: null,
    approval_history: [],
    resulting_revision_id: null,
  });

  const replay = await administrationRequest("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "start-first",
  });
  expect(replay.response.status).toBe(201);
  expect(replay.document).toEqual(started.document);

  const changedReuse = await administrationRequest(
    "/v1/ingestion-runs",
    {
      fixture: "first-catalogue",
      selected_games: ["one-piece", "digimon"],
      idempotency_key: "start-first",
    },
  );
  expect(changedReuse.response.status).toBe(409);
  expect(changedReuse.document).toMatchObject({
    code: "idempotency_key_reused",
  });

  const competing = await administrationRequest("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "start-competing",
  });
  expect(competing.response.status).toBe(409);
  expect(competing.document).toMatchObject({
    code: "active_ingestion_run",
  });

  await administrationRequest(
    `/v1/ingestion-runs/${requiredDocumentString(
      started.document,
      "id",
    )}/rejection`,
    {
      candidate_digest: requiredDocumentString(
        started.document,
        "candidate_digest",
      ),
      idempotency_key: "reject-first",
    },
  );
  const failedReplay = await administrationRequest(
    "/v1/ingestion-runs",
    {
      fixture: "first-catalogue",
      selected_games: ["one-piece"],
      idempotency_key: "start-competing",
    },
  );
  expect(failedReplay.response.status).toBe(409);
  expect({
    ...failedReplay.document,
    request_id: "<request>",
  }).toEqual({
    ...competing.document,
    request_id: "<request>",
  });

  const changedFailedReplay = await administrationRequest(
    "/v1/ingestion-runs",
    {
      fixture: "first-catalogue",
      selected_games: ["one-piece", "digimon"],
      idempotency_key: "start-competing",
    },
  );
  expect(changedFailedReplay.response.status).toBe(409);
  expect(changedFailedReplay.document).toMatchObject({
    code: "idempotency_key_reused",
  });
});

test("stale and mismatched approvals leave the candidate unchanged before exact approval publishes", async () => {
  const started = await startRun("start-approval");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const expectedRevision = requiredDocumentString(
    started.document,
    "expected_current_revision_id",
  );
  const attemptedRewrite = await administrationRequest(
    `/v1/ingestion-runs/${runId}/approval`,
    {
      candidate_digest: digest,
      expected_current_revision_id: expectedRevision,
      idempotency_key: "approve-rewrite",
      approval_deadline: "2999-01-01T00:00:00.000Z",
      candidate_created_at: "1970-01-01T00:00:00.000Z",
    },
  );
  expect(attemptedRewrite.response.status).toBe(422);
  expect(attemptedRewrite.document).toMatchObject({
    code: "invalid_parameter",
  });
  expect((await showRun(runId)).document).toEqual(started.document);

  const staleDigest = await approve(
    runId,
    "0".repeat(64),
    expectedRevision,
    "approve-stale-digest",
  );
  expect(staleDigest.response.status).toBe(409);
  expect(staleDigest.document).toMatchObject({
    code: "candidate_digest_mismatch",
  });
  const staleRevision = await approve(
    runId,
    digest,
    "catrev_stale",
    "approve-stale-revision",
  );
  expect(staleRevision.response.status).toBe(409);
  expect(staleRevision.document).toMatchObject({
    code: "current_revision_mismatch",
  });
  expect((await showRun(runId)).document).toEqual(started.document);
  const guardedStatus = await administrationRequest("/v1/status");
  expect(guardedStatus.document).toMatchObject({
    diagnostics: {
      catalogue_export_object_count: 0,
      orphaned_catalogue_export_object_count: 0,
    },
  });

  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE operation_state
    SET active_ingestion_run_id = 'run_mismatched'
    WHERE singleton = 1`,
  ).run();
  const mismatchedIdentity = await approve(
    runId,
    digest,
    expectedRevision,
    "approve-mismatched-identity",
  );
  expect(mismatchedIdentity.response.status).toBe(409);
  expect(mismatchedIdentity.document).toMatchObject({
    code: "run_not_active",
  });
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE operation_state
    SET active_ingestion_run_id = ?
    WHERE singleton = 1`,
  )
    .bind(runId)
    .run();
  expect((await showRun(runId)).document).toEqual(started.document);

  const published = await approve(
    runId,
    digest,
    expectedRevision,
    "approve-exact",
  );
  expect(published.response.status).toBe(200);
  expect(published.document).toMatchObject({
    id: runId,
    state: "published",
    publication_outcome: "revision",
    approval_history: [
      {
        action: "approved",
        candidate_digest: digest,
        expected_current_revision_id: expectedRevision,
      },
    ],
    progress: {
      current_stage: "published",
    },
    failure_code: null,
  });
  expect(published.document.resulting_revision_id).toBe(
    published.document.published_revision_id,
  );

  const replay = await approve(
    runId,
    digest,
    expectedRevision,
    "approve-exact",
  );
  expect(replay.document).toEqual(published.document);
  const changedReplay = await approve(
    runId,
    "f".repeat(64),
    expectedRevision,
    "approve-exact",
  );
  expect(changedReplay.response.status).toBe(409);
  expect(changedReplay.document).toMatchObject({
    code: "idempotency_key_reused",
  });
});

test("identical concurrent approvals replay one original publication result", async () => {
  const started = await startRun("start-concurrent-approval");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const expectedRevision = requiredDocumentString(
    started.document,
    "expected_current_revision_id",
  );
  const approvals = await Promise.all([
    approve(
      runId,
      digest,
      expectedRevision,
      "approve-concurrently",
    ),
    approve(
      runId,
      digest,
      expectedRevision,
      "approve-concurrently",
    ),
  ]);
  expect(
    approvals.every(({ response }) =>
      [200, 202].includes(response.status),
    ),
  ).toBe(true);
  const original = approvals.find(
    ({ response }) => response.status === 200,
  );
  expect(original).toBeDefined();
  const replay = await approve(
    runId,
    digest,
    expectedRevision,
    "approve-concurrently",
  );
  expect(replay.response.status).toBe(200);
  expect(replay.document).toEqual(original?.document);
  expect(replay.document).toMatchObject({
    id: runId,
    state: "published",
  });
});

test("malformed persisted JSON is rejected instead of crossing the administration seam", async () => {
  const started = await startRun("start-malformed-persistence");
  const runId = requiredDocumentString(started.document, "id");
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
    SET progress_json = '{"completed_stages":["planning","parsing"],"current_stage":"awaiting_approval"}'
    WHERE id = ?`,
  )
    .bind(runId)
    .run();
  const malformed = await showRun(runId);
  expect(malformed.response.status).toBe(500);
  expect(malformed.document).toMatchObject({
    code: "internal_error",
  });
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
    SET progress_json = ?,
        approval_history_json = '[{"action":"approved"}]'
    WHERE id = ?`,
  )
    .bind(
      JSON.stringify({
        completed_stages: [
          "planning",
          "collecting",
          "parsing",
          "reconciling",
        ],
        current_stage: "awaiting_approval",
      }),
      runId,
    )
    .run();
  const malformedAudit = await showRun(runId);
  expect(malformedAudit.response.status).toBe(500);
  expect(malformedAudit.document).toMatchObject({
    code: "internal_error",
  });
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
    SET approval_history_json = '[]'
    WHERE id = ?`,
  )
    .bind(runId)
    .run();
});

test("a partial persisted success cannot masquerade as an original run result", async () => {
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO administration_idempotency (
      idempotency_key,
      operation,
      request_json,
      response_json,
      http_status,
      outcome,
      created_at
    ) VALUES (?, 'start_ingestion_run', ?, ?, 201, 'success', ?)`,
  )
    .bind(
      "start-partial-success-replay",
      `{"fixture":"first-catalogue","selected_games":["one-piece"]}`,
      JSON.stringify({
        id: "run_partial",
        state: "awaiting_approval",
        selected_games: ["one-piece"],
        started_at: "2026-07-29T00:00:00.000Z",
      }),
      "2026-07-29T00:00:00.000Z",
    )
    .run();
  const replay = await startRun("start-partial-success-replay");
  expect(replay.response.status).toBe(500);
  expect(replay.document).toMatchObject({
    code: "internal_error",
  });
});

test("successful replay status, request correlation, and state legality are exact", async () => {
  const started = await startRun("start-replay-correlation-source");
  const requestJson =
    `{"fixture":"first-catalogue","selected_games":["one-piece"]}`;
  const createdAt = "2026-07-29T00:00:00.000Z";
  const cases = [
    {
      key: "start-invalid-success-status",
      status: 200,
      response: started.document,
    },
    {
      key: "start-mismatched-success-run",
      status: 201,
      response: started.document,
    },
    {
      key: "start-impossible-success-state",
      status: 201,
      response: {
        ...started.document,
        idempotency_key: "start-impossible-success-state",
        approval: {
          action: "approved",
          approved_at: requiredDocumentString(
            started.document,
            "started_at",
          ),
          candidate_digest: requiredDocumentString(
            started.document,
            "candidate_digest",
          ),
          expected_current_revision_id: requiredDocumentString(
            started.document,
            "expected_current_revision_id",
          ),
        },
        approval_history: [],
      },
    },
  ];
  for (const testCase of cases) {
    await testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO administration_idempotency (
        idempotency_key,
        operation,
        request_json,
        response_json,
        http_status,
        outcome,
        created_at
      ) VALUES (?, 'start_ingestion_run', ?, ?, ?, 'success', ?)`,
    )
      .bind(
        testCase.key,
        requestJson,
        JSON.stringify(testCase.response),
        testCase.status,
        createdAt,
      )
      .run();
    const replay = await startRun(testCase.key);
    expect(replay.response.status).toBe(500);
    expect(replay.document).toMatchObject({
      code: "internal_error",
    });
  }
});

test("rejection is terminal and retry creates a fresh linked run", async () => {
  const started = await startRun("start-reject");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const rejected = await administrationRequest(
    `/v1/ingestion-runs/${runId}/rejection`,
    {
      candidate_digest: digest,
      idempotency_key: "reject-exact",
    },
  );
  expect(rejected.response.status).toBe(200);
  expect(rejected.document).toMatchObject({
    id: runId,
    state: "rejected",
    approval_history: [
      {
        action: "rejected",
        candidate_digest: digest,
      },
    ],
    progress: {
      completed_stages: [
        "planning",
        "collecting",
        "parsing",
        "reconciling",
      ],
      current_stage: "rejected",
    },
  });

  const retry = await administrationRequest(
    `/v1/ingestion-runs/${runId}/retry`,
    { idempotency_key: "retry-rejected" },
  );
  expect(retry.response.status).toBe(201);
  expect(retry.document).toMatchObject({
    state: "awaiting_approval",
    linked_run_id: runId,
  });
  expect(retry.document.id).not.toBe(runId);
  expect((await showRun(runId)).document).toEqual(rejected.document);

  const replay = await administrationRequest(
    `/v1/ingestion-runs/${runId}/retry`,
    { idempotency_key: "retry-rejected" },
  );
  expect(replay.document).toEqual(retry.document);
});

test("a candidate expires at its exact seven-day boundary and releases the run lock", async () => {
  testObservedAt = "2026-07-29T00:00:00.000Z";
  const started = await startRun("start-expiry");
  const runId = requiredDocumentString(started.document, "id");
  const createdAt = requiredDocumentString(
    started.document,
    "candidate_created_at",
  );
  const deadline = requiredDocumentString(
    started.document,
    "approval_deadline",
  );
  expect(Date.parse(deadline) - Date.parse(createdAt)).toBe(
    7 * 24 * 60 * 60 * 1_000,
  );

  testObservedAt = deadline;
  const expired = await showRun(runId);
  expect(expired.document).toMatchObject({
    state: "expired",
    resulting_revision_id: null,
    progress: {
      completed_stages: [
        "planning",
        "collecting",
        "parsing",
        "reconciling",
      ],
      current_stage: "expired",
    },
  });

  const lateApproval = await approve(
    runId,
    requiredDocumentString(started.document, "candidate_digest"),
    requiredDocumentString(
      started.document,
      "expected_current_revision_id",
    ),
    "approve-late",
  );
  expect(lateApproval.response.status).toBe(409);
  expect(lateApproval.document).toMatchObject({
    code: "candidate_expired",
  });

  const replacement = await startRun("start-after-expiry");
  expect(replacement.response.status).toBe(201);
});

test("expiry repairs a dangling active identity and still wins at the deadline", async () => {
  testObservedAt = "2026-07-29T02:00:00.000Z";
  const started = await startRun("start-expiry-pointer-repair");
  const runId = requiredDocumentString(started.document, "id");
  const deadline = requiredDocumentString(
    started.document,
    "approval_deadline",
  );
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE operation_state
    SET active_ingestion_run_id = 'run_dangling_pointer'
    WHERE singleton = 1`,
  ).run();

  testObservedAt = deadline;
  const expired = await showRun(runId);
  expect(expired.response.status).toBe(200);
  expect(expired.document).toMatchObject({
    id: runId,
    state: "expired",
    terminal_at: deadline,
  });
  const status = await administrationRequest("/v1/status");
  expect(status.document).toMatchObject({
    safe_state: {
      active_ingestion_run_id: null,
      mutation_safe: true,
    },
  });
  const replacement = await startRun("start-after-pointer-repair");
  expect(replacement.response.status).toBe(201);
});

test("an interrupted publication fails atomically and leaves cleanup independently retryable", async () => {
  testObservedAt = "2026-07-29T00:00:00.000Z";
  const started = await startRun("start-interrupted-publication");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const expectedRevision = requiredDocumentString(
    started.document,
    "expected_current_revision_id",
  );
  const revisionId = "catrev_interrupted";
  const approvalKey = "approve-interrupted";
  const approval = {
    action: "approved",
    approved_at: testObservedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  const reconcileAfter = "2026-07-29T00:05:00.000Z";
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
    SET state = 'publishing',
        approval_json = ?,
        approval_idempotency_key = ?,
        approval_history_json = ?,
        progress_json = ?,
        publication_revision_id = ?,
        publication_started_at = ?,
        publication_reconcile_after = ?,
        publication_manifest_digest = ?
    WHERE id = ? AND state = 'awaiting_approval'`,
  )
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: [
          "planning",
          "collecting",
          "parsing",
          "reconciling",
          "awaiting_approval",
        ],
        current_stage: "publishing",
      }),
      revisionId,
      testObservedAt,
      reconcileAfter,
      "f".repeat(64),
      runId,
    )
    .run();

  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_runs
      SET approval_json = '{}'
      WHERE id = ?`,
    )
      .bind(runId)
      .run(),
  ).rejects.toThrow("reserved_approval_immutable");

  testObservedAt = reconcileAfter;
  const status = await administrationRequest("/v1/status");
  expect(status.response.status).toBe(200);
  expect(status.document).toMatchObject({
    safe_state: {
      active_ingestion_run_id: null,
      mutation_safe: true,
    },
    diagnostics: {
      pending_publication_cleanup_count: 1,
    },
  });
  const recentRuns = status.document.recent_runs;
  expect(Array.isArray(recentRuns)).toBe(true);
  expect(
    Array.isArray(recentRuns)
      ? recentRuns.find(
          (run) =>
            typeof run === "object" &&
            run !== null &&
            "id" in run &&
            run.id === runId,
        )
      : null,
  ).toMatchObject({
    id: runId,
    state: "failed",
    failure_code: "publication_abandoned",
    publication_cleanup: {
      state: "pending",
      attempts: 0,
    },
  });

  const replay = await approve(
    runId,
    digest,
    expectedRevision,
    approvalKey,
  );
  expect(replay.response.status).toBe(500);
  expect(replay.document).toMatchObject({
    code: "publication_abandoned",
  });

  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_publication_cleanup
    SET state = 'failed',
        attempts = 1,
        failure_code = 'synthetic_delete_failure',
        last_attempt_at = ?
    WHERE ingestion_run_id = ?`,
  )
    .bind(testObservedAt, runId)
    .run();
  const failedCleanup = await showRun(runId);
  expect(failedCleanup.document).toMatchObject({
    state: "failed",
    failure_code: "publication_abandoned",
    publication_cleanup: {
      state: "failed",
      failure_code: "synthetic_delete_failure",
    },
  });

  const replacement = await startRun(
    "start-after-interrupted-publication",
  );
  expect(replacement.response.status).toBe(201);

  testObservedAt = "2026-07-29T00:10:00.000Z";
  const cleanupAttempts = await Promise.all([
    administrationRequest(
      `/v1/ingestion-runs/${runId}/publication-cleanup`,
      { idempotency_key: "cleanup-interrupted-publication" },
    ),
    administrationRequest(
      `/v1/ingestion-runs/${runId}/publication-cleanup`,
      { idempotency_key: "cleanup-interrupted-publication" },
    ),
  ]);
  expect(
    cleanupAttempts.some(({ response }) => response.status === 200),
  ).toBe(true);
  const cleanup = await administrationRequest(
    `/v1/ingestion-runs/${runId}/publication-cleanup`,
    { idempotency_key: "cleanup-interrupted-publication" },
  );
  expect(cleanup.response.status).toBe(200);
  expect(cleanup.document).toMatchObject({
    state: "failed",
    failure_code: "publication_abandoned",
    publication_cleanup: {
      state: "completed",
      attempts: 2,
      failure_code: null,
    },
  });
  const cleanupReplay = await administrationRequest(
    `/v1/ingestion-runs/${runId}/publication-cleanup`,
    { idempotency_key: "cleanup-interrupted-publication" },
  );
  expect(cleanupReplay.document).toEqual(cleanup.document);
});

test("an interrupted publication finalizes only its exact verified export", async () => {
  testObservedAt = "2026-07-29T01:00:00.000Z";
  const started = await startRun("start-complete-interruption");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const expectedRevision = requiredDocumentString(
    started.document,
    "expected_current_revision_id",
  );
  const revisionId = "catrev_complete_interruption";
  const approvalKey = "approve-complete-interruption";
  const approval = {
    action: "approved",
    approved_at: testObservedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  const candidate = await fixtureCandidate("first-catalogue", [
    "one-piece",
  ]);
  const catalogueExport = await buildCatalogueExport(
    candidate.candidate,
    digest,
    revisionId,
    testObservedAt,
  );
  const reconcileAfter = "2026-07-29T01:05:00.000Z";
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
    SET state = 'publishing',
        approval_json = ?,
        approval_idempotency_key = ?,
        approval_history_json = ?,
        progress_json = ?,
        publication_revision_id = ?,
        publication_started_at = ?,
        publication_reconcile_after = ?,
        publication_manifest_digest = ?
    WHERE id = ? AND state = 'awaiting_approval'`,
  )
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: [
          "planning",
          "collecting",
          "parsing",
          "reconciling",
          "awaiting_approval",
        ],
        current_stage: "publishing",
      }),
      revisionId,
      testObservedAt,
      reconcileAfter,
      catalogueExport.manifest.manifest_sha256,
      runId,
    )
    .run();
  const inProgress = await approve(
    runId,
    digest,
    expectedRevision,
    approvalKey,
  );
  expect(inProgress.response.status).toBe(202);
  expect(inProgress.document).toMatchObject({
    contract: "card-keepr-administration-operation@1",
    operation: "approve_ingestion_run",
    status: "in_progress",
    run_id: runId,
    idempotency_key: approvalKey,
    retry_after: reconcileAfter,
  });
  const inProgressReplay = await approve(
    runId,
    digest,
    expectedRevision,
    approvalKey,
  );
  expect(inProgressReplay.response.status).toBe(202);
  expect(inProgressReplay.document).toEqual(inProgress.document);
  for (const object of catalogueExport.objects) {
    await testEnv.CATALOGUE_EXPORTS.put(object.key, object.bytes);
  }
  const listed = await testEnv.CATALOGUE_EXPORTS.list({
    prefix: `catalogue-exports/${revisionId}/`,
  });
  expect(
    listed.objects.map((object) => object.key).sort(),
  ).toEqual(
    [...new Set(catalogueExport.objects.map((object) => object.key))].sort(),
  );
  for (const object of catalogueExport.objects) {
    expect((await testEnv.CATALOGUE_EXPORTS.get(object.key))?.size).toBe(
      object.bytes.byteLength,
    );
  }

  testObservedAt = reconcileAfter;
  const reconciled = await showRun(runId);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document).toMatchObject({
    id: runId,
    state: "published",
    publication_outcome: "revision",
    published_revision_id: revisionId,
    resulting_revision_id: revisionId,
    export_manifest_digest:
      catalogueExport.manifest.manifest_sha256,
    publication_cleanup: null,
  });
  const replay = await approve(
    runId,
    digest,
    expectedRevision,
    approvalKey,
  );
  expect(replay.response.status).toBe(200);
  expect(replay.document).toEqual(reconciled.document);
});

test("unexpected recovery keys fail publication and are all removed by cleanup", async () => {
  testObservedAt = "2026-07-29T03:00:00.000Z";
  const before = await administrationRequest("/v1/status");
  const beforeDiagnostics = requiredDocumentRecord(
    before.document,
    "diagnostics",
  );
  const beforeObjectCount = requiredDocumentNumber(
    beforeDiagnostics,
    "catalogue_export_object_count",
  );
  const started = await startRun("start-unexpected-recovery-key");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const expectedRevision = requiredDocumentString(
    started.document,
    "expected_current_revision_id",
  );
  const revisionId = "catrev_unexpected_recovery_key";
  const approvalKey = "approve-unexpected-recovery-key";
  const approval = {
    action: "approved",
    approved_at: testObservedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  const candidate = await fixtureCandidate("first-catalogue", [
    "one-piece",
  ]);
  const catalogueExport = await buildCatalogueExport(
    candidate.candidate,
    digest,
    revisionId,
    testObservedAt,
  );
  for (const object of catalogueExport.objects) {
    await testEnv.CATALOGUE_EXPORTS.put(object.key, object.bytes);
  }
  await testEnv.CATALOGUE_EXPORTS.put(
    `catalogue-exports/${revisionId}/unexpected.bin`,
    new Uint8Array([1, 2, 3]),
  );
  const reconcileAfter = "2026-07-29T03:05:00.000Z";
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
    SET state = 'publishing',
        approval_json = ?,
        approval_idempotency_key = ?,
        approval_history_json = ?,
        progress_json = ?,
        publication_revision_id = ?,
        publication_started_at = ?,
        publication_reconcile_after = ?,
        publication_manifest_digest = ?
    WHERE id = ? AND state = 'awaiting_approval'`,
  )
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: [
          "planning",
          "collecting",
          "parsing",
          "reconciling",
          "awaiting_approval",
        ],
        current_stage: "publishing",
      }),
      revisionId,
      testObservedAt,
      reconcileAfter,
      catalogueExport.manifest.manifest_sha256,
      runId,
    )
    .run();

  testObservedAt = reconcileAfter;
  const reconciled = await showRun(runId);
  expect(reconciled.document).toMatchObject({
    state: "failed",
    failure_code: "publication_abandoned",
    publication_cleanup: { state: "pending" },
  });
  await testEnv.CATALOGUE_EXPORTS.put(
    `catalogue-exports/${revisionId}/late-unexpected.bin`,
    new Uint8Array([4, 5, 6]),
  );
  const fencedCleanup = await administrationRequest(
    `/v1/ingestion-runs/${runId}/publication-cleanup`,
    { idempotency_key: "cleanup-unexpected-recovery-key" },
  );
  expect(fencedCleanup.response.status).toBe(409);
  expect(fencedCleanup.document).toMatchObject({
    code: "publication_cleanup_fenced",
  });
  await testEnv.CATALOGUE_EXPORTS.put(
    `catalogue-exports/${revisionId}/late-in-flight.bin`,
    new Uint8Array([7, 8, 9]),
  );
  testObservedAt = "2026-07-29T03:10:00.000Z";
  const cleanup = await administrationRequest(
    `/v1/ingestion-runs/${runId}/publication-cleanup`,
    { idempotency_key: "cleanup-unexpected-recovery-key" },
  );
  expect(cleanup.document).toMatchObject({
    publication_cleanup: { state: "completed" },
  });
  const after = await administrationRequest("/v1/status");
  const afterDiagnostics = requiredDocumentRecord(
    after.document,
    "diagnostics",
  );
  expect(
    requiredDocumentNumber(
      afterDiagnostics,
      "catalogue_export_object_count",
    ),
  ).toBe(beforeObjectCount);
});

test("an unchanged successful retry advances freshness without another revision or export", async () => {
  const before = await administrationRequest("/v1/status");
  const beforeDiagnostics = before.document.diagnostics;
  if (
    typeof beforeDiagnostics !== "object" ||
    beforeDiagnostics === null ||
    !("catalogue_revision_count" in beforeDiagnostics) ||
    typeof beforeDiagnostics.catalogue_revision_count !== "number" ||
    !("catalogue_export_count" in beforeDiagnostics) ||
    typeof beforeDiagnostics.catalogue_export_count !== "number"
  ) {
    throw new Error("status diagnostics are invalid");
  }
  const first = await startRun("start-first-publication");
  const firstPublished = await approve(
    requiredDocumentString(first.document, "id"),
    requiredDocumentString(first.document, "candidate_digest"),
    requiredDocumentString(
      first.document,
      "expected_current_revision_id",
    ),
    "approve-first-publication",
  );
  const revisionId = requiredDocumentString(
    firstPublished.document,
    "resulting_revision_id",
  );
  const retry = await administrationRequest(
    `/v1/ingestion-runs/${requiredDocumentString(
      firstPublished.document,
      "id",
    )}/retry`,
    { idempotency_key: "retry-no-change" },
  );
  const unchanged = await approve(
    requiredDocumentString(retry.document, "id"),
    requiredDocumentString(retry.document, "candidate_digest"),
    revisionId,
    "approve-no-change",
  );
  expect(unchanged.response.status).toBe(200);
  expect(unchanged.document).toMatchObject({
    state: "published",
    publication_outcome: "no_change",
    published_revision_id: null,
    resulting_revision_id: revisionId,
  });
  expect(unchanged.document.freshness_checked_at).toEqual(
    expect.any(String),
  );

  const status = await administrationRequest("/v1/status");
  expect(status.response.status).toBe(200);
  expect(status.document).toMatchObject({
    contract: "card-keepr-administration-status@1",
    safe_state: {
      current_revision_id: revisionId,
      active_ingestion_run_id: null,
      mutation_safe: true,
    },
    source_freshness: [
      {
        game: "one-piece",
        area: "cards-and-printings",
        ingestion_run_id: unchanged.document.id,
      },
    ],
  });
  const diagnostics = status.document.diagnostics;
  const expectedNewRevision =
    firstPublished.document.publication_outcome === "revision" ? 1 : 0;
  expect(diagnostics).toMatchObject({
    catalogue_revision_count:
      beforeDiagnostics.catalogue_revision_count + expectedNewRevision,
    catalogue_export_count:
      beforeDiagnostics.catalogue_export_count + expectedNewRevision,
  });
});

async function administrationRequest(
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `192.0.2.${(requestSequence++ % 250) + 1}`,
        ...(testObservedAt === null
          ? {}
          : { "x-keepr-test-now": testObservedAt }),
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

function startRun(
  idempotencyKey: string,
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  return administrationRequest("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: idempotencyKey,
  });
}

function approve(
  runId: string,
  candidateDigest: string,
  expectedRevision: string,
  idempotencyKey: string,
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  return administrationRequest(
    `/v1/ingestion-runs/${runId}/approval`,
    {
      candidate_digest: candidateDigest,
      expected_current_revision_id: expectedRevision,
      idempotency_key: idempotencyKey,
    },
  );
}

function showRun(
  runId: string,
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  return administrationRequest(`/v1/ingestion-runs/${runId}`);
}

function requiredDocumentString(
  document: Record<string, unknown>,
  field: string,
): string {
  const value = document[field];
  if (typeof value !== "string") {
    throw new Error(`${field} is not a string`);
  }
  return value;
}

function requiredDocumentRecord(
  document: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = document[field];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredDocumentNumber(
  document: Record<string, unknown>,
  field: string,
): number {
  const value = document[field];
  if (typeof value !== "number") {
    throw new Error(`${field} is not a number`);
  }
  return value;
}
