import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";

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

test("an unchanged successful retry advances freshness without another revision or export", async () => {
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
    diagnostics: {
      catalogue_revision_count: 1,
      catalogue_export_count: 1,
    },
    source_freshness: [
      {
        game: "one-piece",
        area: "cards-and-printings",
        ingestion_run_id: unchanged.document.id,
      },
    ],
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
