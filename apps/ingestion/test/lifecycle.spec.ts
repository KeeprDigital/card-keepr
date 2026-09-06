import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import {
  approveRun as approveRunDirect,
  retryPublicationCleanup as retryPublicationCleanupDirect,
  showRun as showRunDirect,
} from "../../../src/catalogue/ingestion/ingestion";
import {
  AdministrationProblem,
  canonicalJson,
  catalogueRevisionIdentity,
  catalogueStore,
  sha256Text,
} from "../../../src/catalogue/shared";
import { fixtureCandidate } from "../../../test/support/catalogue-fixture";
import { fixturePublicationSourceId } from "../../../test/support/fixture-publication";
import ingestionWorker from "../src/index";
import { injectFixturePublication } from "./fixture-plan-injection";
import * as catalogueExportQueries from "./query-helpers/catalogue-export";
import {
  countDeletionResponseQueriesDatabase,
  crashAfterRetryTerminalDatabase,
} from "./query-helpers/database-failures";
import * as ingestionQueries from "./query-helpers/ingestion";
import { disableExportTransitionTriggers } from "./query-helpers/maintenance-guards";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};
let requestSequence = 0;
let testObservedAt: string | null = null;

beforeEach(async () => {
  testObservedAt = null;
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await disableExportTransitionTriggers(testEnv.CATALOGUE_DB);
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
    await administrationRequest(`/v1/ingestion-runs/${active.id}/rejection`, {
      candidate_digest: active.candidate_digest,
      idempotency_key: `cleanup-${crypto.randomUUID()}`,
    });
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

test("administration status excludes the unpublished bootstrap spine from the repairable revision chain", async () => {
  const status = await administrationRequest("/v1/status");

  expect(status.response.status).toBe(200);
  expect(status.document).toMatchObject({
    safe_state: {
      current_revision_id: "catrev_spine_000",
    },
    repairable_catalogue_revision_ids: [],
  });
});

test("the public run boundary reads and retries an immutable retained candidate", async () => {
  const runId = "run_historical_fixed_point_candidate";
  const historicalCandidate = {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [
      {
        id: "card_01k_first_catalogue_0001",
        game: "one-piece",
        official_identity: {
          kind: "card_number",
          value: "OP01-001",
        },
        name: "Monkey.D.Luffy",
        effective_rules_text: "[DON!! x1] This Leader gains +1000 power during your turn.",
        game_data: {
          profile: "one-piece@1",
          attributes: {
            card_type: "leader",
            colours: ["red"],
            cost: null,
            life: 5,
            battle_attributes: ["strike"],
            power: 5000,
            counter: null,
            traits: ["Straw Hat Crew"],
            block_icons: ["1"],
            effect_text: "[DON!! x1] This Leader gains +1000 power during your turn.",
            trigger_text: null,
          },
        },
      },
    ],
    printings: [
      {
        id: "printing_01k_first_catalogue_0001",
        card_id: "card_01k_first_catalogue_0001",
        rarity: { normalized: "leader", raw: "L" },
        printed_rules_text: "[DON!! x1] This Leader gains +1000 power during your turn.",
        game_data: {
          profile: "one-piece@1",
          attributes: { illustration_types: [] },
        },
      },
    ],
  } as const;
  const immutableCandidateJson = canonicalJson(historicalCandidate);
  const historicalDigest = await sha256Text(immutableCandidateJson);
  await ingestionQueries
    .insertIngestionRunsForPublicRunBoundaryReadsRetriesImmutableFixedPointLegacy(testEnv.CATALOGUE_DB)
    .bind(runId, historicalDigest, immutableCandidateJson)
    .run();

  const shown = await showRun(runId);
  expect(shown.response.status).toBe(200);
  expect(shown.document).toMatchObject({
    id: runId,
    state: "failed",
    candidate_digest: historicalDigest,
  });

  const retried = await administrationRequest(`/v1/ingestion-runs/${runId}/retry`, {
    idempotency_key: "retry-historical-fixed-point",
  });
  expect(retried.response.status).toBe(201);
  expect(retried.document).toMatchObject({
    state: "awaiting_approval",
    linked_run_id: runId,
  });

  const persisted = await ingestionQueries
    .readIngestionRunsIdCandidateJson(testEnv.CATALOGUE_DB)
    .bind(runId, requiredDocumentString(retried.document, "id"))
    .all<{ id: string; candidate_json: string }>();
  const original = persisted.results.find((row) => row.id === runId);
  const replacement = persisted.results.find((row) => row.id !== runId);
  expect(original?.candidate_json).toBe(immutableCandidateJson);
  expect(JSON.parse(original!.candidate_json)).toHaveProperty("contract", "card-keepr-catalogue-candidate@1");
  expect(JSON.parse(replacement!.candidate_json)).toHaveProperty("contract", "card-keepr-catalogue-candidate@1");
});

test("a lengthless administration body is rejected while streaming beyond 16 KiB", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls > 2) {
          controller.error(new Error("the Worker read beyond the bounded prefix"));
          return;
        }
        controller.enqueue(new Uint8Array(10_000));
      },
    },
    { highWaterMark: 0 },
  );
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/ingestion-runs/evidence", {
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
      completed_stages: ["planning", "collecting", "parsing", "reconciling"],
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

  const changedReuse = await administrationRequest("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece", "digimon"],
    idempotency_key: "start-first",
  });
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

  await administrationRequest(`/v1/ingestion-runs/${requiredDocumentString(started.document, "id")}/rejection`, {
    candidate_digest: requiredDocumentString(started.document, "candidate_digest"),
    idempotency_key: "reject-first",
  });
  const failedReplay = await administrationRequest("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "start-competing",
  });
  expect(failedReplay.response.status).toBe(409);
  expect({
    ...failedReplay.document,
    request_id: "<request>",
  }).toEqual({
    ...competing.document,
    request_id: "<request>",
  });

  const changedFailedReplay = await administrationRequest("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece", "digimon"],
    idempotency_key: "start-competing",
  });
  expect(changedFailedReplay.response.status).toBe(409);
  expect(changedFailedReplay.document).toMatchObject({
    code: "idempotency_key_reused",
  });
});

test("stale and mismatched approvals leave the candidate unchanged before exact approval publishes", async () => {
  const started = await startRun("start-approval");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const attemptedRewrite = await administrationRequest(`/v1/ingestion-runs/${runId}/approval`, {
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
    idempotency_key: "approve-rewrite",
    approval_deadline: "2999-01-01T00:00:00.000Z",
    candidate_created_at: "1970-01-01T00:00:00.000Z",
  });
  expect(attemptedRewrite.response.status).toBe(422);
  expect(attemptedRewrite.document).toMatchObject({
    code: "invalid_parameter",
  });
  expect((await showRun(runId)).document).toEqual(started.document);

  const staleDigest = await approve(runId, "0".repeat(64), expectedRevision, "approve-stale-digest");
  expect(staleDigest.response.status).toBe(409);
  expect(staleDigest.document).toMatchObject({
    code: "candidate_digest_mismatch",
  });
  const staleRevision = await approve(runId, digest, "catrev_stale", "approve-stale-revision");
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

  await ingestionQueries
    .setOperationStateActiveIngestionRunIdForStaleMismatchedApprovalsLeaveCandidateUnchangedBeforeExactApproval(
      testEnv.CATALOGUE_DB,
    )
    .run();
  const mismatchedIdentity = await approve(runId, digest, expectedRevision, "approve-mismatched-identity");
  expect(mismatchedIdentity.response.status).toBe(409);
  expect(mismatchedIdentity.document).toMatchObject({
    code: "run_not_active",
  });
  await ingestionQueries
    .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
      testEnv.CATALOGUE_DB,
    )
    .bind(runId)
    .run();
  expect((await showRun(runId)).document).toEqual(started.document);

  const published = await approve(runId, digest, expectedRevision, "approve-exact");
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
  expect(published.document.resulting_revision_id).toBe(published.document.published_revision_id);

  const replay = await approve(runId, digest, expectedRevision, "approve-exact");
  expect(replay.document).toEqual(published.document);
  const changedReplay = await approve(runId, "f".repeat(64), expectedRevision, "approve-exact");
  expect(changedReplay.response.status).toBe(409);
  expect(changedReplay.document).toMatchObject({
    code: "idempotency_key_reused",
  });
});

test("identical concurrent approvals replay one original publication result", async () => {
  const started = await startRun("start-concurrent-approval");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const approvals = await Promise.all([
    approve(runId, digest, expectedRevision, "approve-concurrently"),
    approve(runId, digest, expectedRevision, "approve-concurrently"),
  ]);
  expect(approvals.every(({ response }) => [200, 202].includes(response.status))).toBe(true);
  const original = approvals.find(({ response }) => response.status === 200);
  expect(original).toBeDefined();
  const replay = await approve(runId, digest, expectedRevision, "approve-concurrently");
  expect(replay.response.status).toBe(200);
  expect(replay.document).toEqual(original?.document);
  expect(replay.document).toMatchObject({
    id: runId,
    state: "published",
  });
});

test("an orphaned retry claim returns stable progress before its lease and resumes by CAS after expiry", async () => {
  const claimedAt = "2026-07-29T04:00:00.000Z";
  const expiresAt = "2026-07-29T04:05:00.000Z";
  const key = "start-orphaned-claim";
  const requestJson = await fixtureRetryRequestJson(key);
  await ingestionQueries
    .insertAdministrationIdempotencyClaims(testEnv.CATALOGUE_DB)
    .bind(key, requestJson, claimedAt, "administration-claim:terminated-start", expiresAt)
    .run();

  testObservedAt = "2026-07-29T04:01:00.000Z";
  const pending = await startRun(key);
  expect(pending.response.status).toBe(202);
  expect(pending.document).toMatchObject({
    contract: "card-keepr-administration-operation@1",
    operation: "retry_ingestion_run",
    status: "in_progress",
    idempotency_key: key,
    claimed_at: claimedAt,
  });
  const pendingReplay = await startRun(key);
  expect(pendingReplay.document).toEqual(pending.document);
  const changed = await administrationRequest("/v1/ingestion-runs/another-retained-source/retry", {
    idempotency_key: key,
  });
  expect(changed.response.status).toBe(409);
  expect(changed.document).toMatchObject({
    code: "idempotency_key_reused",
  });

  testObservedAt = expiresAt;
  const resumed = await startRun(key);
  expect(resumed.response.status).toBe(201);
  expect(resumed.document).toMatchObject({
    state: "awaiting_approval",
    idempotency_key: key,
  });
  const remainingClaim = await ingestionQueries
    .readAdministrationIdempotencyClaimsIdempotencyKey(testEnv.CATALOGUE_DB)
    .bind(key)
    .first();
  expect(remainingClaim).toBeNull();
});

test("malformed typed progress and approval are rejected at the administration seam", async () => {
  const started = await startRun("start-malformed-persistence");
  const runId = requiredDocumentString(started.document, "id");
  await ingestionQueries.setIngestionRunsProgressJson(testEnv.CATALOGUE_DB).bind(runId).run();
  const malformed = await showRun(runId);
  expect(malformed.response.status).toBe(500);
  expect(malformed.document).toMatchObject({
    code: "internal_error",
  });
  await ingestionQueries
    .setIngestionRunsProgressJsonApprovalHistoryJson(testEnv.CATALOGUE_DB)
    .bind(
      JSON.stringify({
        completed_stages: ["planning", "collecting", "parsing", "reconciling"],
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
  await ingestionQueries.setIngestionRunsApprovalHistoryJson(testEnv.CATALOGUE_DB).bind(runId).run();
});

test("a partial persisted success cannot masquerade as an original run result", async () => {
  await ingestionQueries
    .insertAdministrationIdempotency(testEnv.CATALOGUE_DB)
    .bind(
      "start-partial-success-replay",
      await fixtureRetryRequestJson("start-partial-success-replay"),
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
          approved_at: requiredDocumentString(started.document, "started_at"),
          candidate_digest: requiredDocumentString(started.document, "candidate_digest"),
          expected_current_revision_id: requiredDocumentString(started.document, "expected_current_revision_id"),
        },
        approval_history: [],
      },
    },
  ];
  for (const testCase of cases) {
    await ingestionQueries
      .insertAdministrationIdempotencyForSuccessfulReplayStatusRequestCorrelationStateLegalityAreExact(
        testEnv.CATALOGUE_DB,
      )
      .bind(
        testCase.key,
        await fixtureRetryRequestJson(testCase.key),
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
  const digest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const rejected = await administrationRequest(`/v1/ingestion-runs/${runId}/rejection`, {
    candidate_digest: digest,
    idempotency_key: "reject-exact",
  });
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
      completed_stages: ["planning", "collecting", "parsing", "reconciling"],
      current_stage: "rejected",
    },
    operational_diagnostics: {
      contract: "card-keepr-operational-diagnostics@1",
      references: {
        run_id: runId,
        request_id: null,
        expected_catalogue_revision_id: expectedRevision,
        candidate_digest: digest,
        adapter_versions: [],
        workflow: {
          status_path: `/v1/ingestion-runs/${runId}`,
        },
        backup: { status_path: null },
        recovery: { status_path: "/v1/status" },
      },
      terminal_evidence: {
        state: "rejected",
        failure: {
          code: "ingestion_run_rejected",
          retryability_code: "retryable_rejection",
          retryable: true,
        },
        warning_count: 0,
        approval_decision_count: 1,
      },
      retry: {
        code: "ingestion_run_retry_available",
        source_run_id: runId,
        method: "POST",
        path: `/v1/ingestion-runs/${runId}/retry`,
      },
      retry_available: true,
      diagnosis_sequence: [
        { code: "check_status", path: "/v1/status" },
        {
          code: "inspect_run",
          path: `/v1/ingestion-runs/${runId}`,
        },
        {
          code: "retry_ingestion_run",
          path: `/v1/ingestion-runs/${runId}/retry`,
        },
      ],
    },
  });

  const retry = await administrationRequest(`/v1/ingestion-runs/${runId}/retry`, { idempotency_key: "retry-rejected" });
  expect(retry.response.status).toBe(201);
  expect(retry.document).toMatchObject({
    state: "awaiting_approval",
    linked_run_id: runId,
  });
  expect(retry.document.id).not.toBe(runId);
  expect((await showRun(runId)).document).toEqual(rejected.document);

  const replay = await administrationRequest(`/v1/ingestion-runs/${runId}/retry`, {
    idempotency_key: "retry-rejected",
  });
  expect(replay.document).toEqual(retry.document);
});

test("a candidate expires at its exact seven-day boundary and releases the run lock", async () => {
  testObservedAt = "2026-07-29T00:00:00.000Z";
  const started = await startRun("start-expiry");
  const runId = requiredDocumentString(started.document, "id");
  const createdAt = requiredDocumentString(started.document, "candidate_created_at");
  const deadline = requiredDocumentString(started.document, "approval_deadline");
  expect(Date.parse(deadline) - Date.parse(createdAt)).toBe(7 * 24 * 60 * 60 * 1_000);

  testObservedAt = new Date(Date.parse(deadline) + 2 * 24 * 60 * 60 * 1_000).toISOString();
  const replacement = await startRun("start-after-expiry");
  expect(replacement.response.status).toBe(201);
  const expired = await showRun(runId);
  expect(expired.document).toMatchObject({
    state: "expired",
    terminal_at: deadline,
    resulting_revision_id: null,
    progress: {
      completed_stages: ["planning", "collecting", "parsing", "reconciling"],
      current_stage: "expired",
    },
  });

  const lateApproval = await approve(
    runId,
    requiredDocumentString(started.document, "candidate_digest"),
    requiredDocumentString(started.document, "expected_current_revision_id"),
    "approve-late",
  );
  expect(lateApproval.response.status).toBe(409);
  expect(lateApproval.document).toMatchObject({
    code: "candidate_expired",
  });
});

test("expiry repairs a dangling active identity and still wins at the deadline", async () => {
  testObservedAt = "2026-07-29T02:00:00.000Z";
  const started = await startRun("start-expiry-pointer-repair");
  const runId = requiredDocumentString(started.document, "id");
  const deadline = requiredDocumentString(started.document, "approval_deadline");
  await ingestionQueries
    .setOperationStateActiveIngestionRunIdForExpiryRepairsDanglingActiveIdentityStillWinsAtDeadline(
      testEnv.CATALOGUE_DB,
    )
    .run();

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
  const digest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const revisionId = await catalogueRevisionIdentity({
    runId,
    candidateDigest: digest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const approvalKey = "approve-interrupted";
  const approval = {
    action: "approved",
    approved_at: testObservedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  const reconcileAfter = "2026-07-29T00:05:00.000Z";
  await ingestionQueries
    .setIngestionRunsStateApprovalJson(testEnv.CATALOGUE_DB)
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval"],
        current_stage: "publishing",
      }),
      revisionId,
      testObservedAt,
      reconcileAfter,
      "f".repeat(64),
      `writer:${revisionId}`,
      runId,
    )
    .run();

  await expect(ingestionQueries.setIngestionRunsApprovalJson(testEnv.CATALOGUE_DB).bind(runId).run()).rejects.toThrow(
    "ingestion_run_event_immutable",
  );

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
      ? recentRuns.find((run) => typeof run === "object" && run !== null && "id" in run && run.id === runId)
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

  const replay = await approve(runId, digest, expectedRevision, approvalKey);
  expect(replay.response.status).toBe(500);
  expect(replay.document).toMatchObject({
    code: "publication_abandoned",
  });

  await ingestionQueries
    .setIngestionPublicationCleanupStateAttempts(testEnv.CATALOGUE_DB)
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

  const replacement = await startRun("start-after-interrupted-publication");
  expect(replacement.response.status).toBe(201);

  testObservedAt = "2026-07-29T00:10:00.000Z";
  await testEnv.CATALOGUE_EXPORTS.put(`catalogue-exports/${revisionId}/abandoned.bin`, new Uint8Array([1]));
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  const stalledCleanupBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async delete(keys) {
      deleteStarted.resolve(undefined);
      await releaseDelete.promise;
      return testEnv.CATALOGUE_EXPORTS.delete(keys);
    },
  });
  const staleCleanup = retryPublicationCleanupDirect(
    catalogueStore(testEnv.CATALOGUE_DB),
    stalledCleanupBucket,
    runId,
    { idempotency_key: "cleanup-interrupted-publication" },
    testObservedAt,
  );
  await deleteStarted.promise;
  const inProgressCleanup = await administrationRequest(`/v1/ingestion-runs/${runId}/publication-cleanup`, {
    idempotency_key: "cleanup-interrupted-publication",
  });
  expect(inProgressCleanup.response.status).toBe(202);
  expect(inProgressCleanup.document).toMatchObject({
    contract: "card-keepr-administration-operation@1",
    operation: "retry_publication_cleanup",
    status: "in_progress",
    run_id: runId,
    idempotency_key: "cleanup-interrupted-publication",
    claimed_at: "2026-07-29T00:10:00.000Z",
  });
  const cleanupKeyCrossOperation = await administrationRequest(
    `/v1/ingestion-runs/${requiredDocumentString(replacement.document, "id")}/rejection`,
    {
      candidate_digest: requiredDocumentString(replacement.document, "candidate_digest"),
      idempotency_key: "cleanup-interrupted-publication",
    },
  );
  expect(cleanupKeyCrossOperation.response.status).toBe(409);
  expect(cleanupKeyCrossOperation.document).toMatchObject({
    code: "idempotency_key_reused",
  });
  const competingCleanup = await administrationRequest(`/v1/ingestion-runs/${runId}/publication-cleanup`, {
    idempotency_key: "cleanup-competing-claim",
  });
  expect(competingCleanup.response.status).toBe(409);
  expect(competingCleanup.document).toMatchObject({
    code: "publication_cleanup_in_progress",
  });

  testObservedAt = "2026-07-29T00:15:00.000Z";
  const cleanup = await administrationRequest(`/v1/ingestion-runs/${runId}/publication-cleanup`, {
    idempotency_key: "cleanup-interrupted-publication",
  });
  expect(cleanup.response.status).toBe(200);
  expect(cleanup.document).toMatchObject({
    state: "failed",
    failure_code: "publication_abandoned",
    publication_cleanup: {
      state: "completed",
      attempts: 3,
      failure_code: null,
    },
  });
  releaseDelete.resolve(undefined);
  await expect(staleCleanup).resolves.toEqual(cleanup.document);
  const cleanupReplay = await administrationRequest(`/v1/ingestion-runs/${runId}/publication-cleanup`, {
    idempotency_key: "cleanup-interrupted-publication",
  });
  expect(cleanupReplay.document).toEqual(cleanup.document);
});

test("an interrupted publication finalizes only its exact verified export", async () => {
  testObservedAt = "2026-07-29T01:00:00.000Z";
  const started = await startRun("start-complete-interruption");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const revisionId = await catalogueRevisionIdentity({
    runId,
    candidateDigest: digest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const approvalKey = "approve-complete-interruption";
  const approval = {
    action: "approved",
    approved_at: testObservedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  const candidate = await fixtureCandidate("first-catalogue", ["one-piece"]);
  const catalogueExport = await buildCatalogueExport(candidate.candidate, digest, revisionId, testObservedAt);
  const reconcileAfter = "2026-07-29T01:05:00.000Z";
  await ingestionQueries
    .setIngestionRunsStateApprovalJson(testEnv.CATALOGUE_DB)
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval"],
        current_stage: "publishing",
      }),
      revisionId,
      testObservedAt,
      reconcileAfter,
      catalogueExport.manifest.manifest_sha256,
      `writer:${revisionId}`,
      runId,
    )
    .run();
  const inProgress = await approve(runId, digest, expectedRevision, approvalKey);
  expect(inProgress.response.status).toBe(202);
  expect(inProgress.document).toMatchObject({
    contract: "card-keepr-administration-operation@1",
    operation: "approve_ingestion_run",
    status: "in_progress",
    run_id: runId,
    idempotency_key: approvalKey,
    claimed_at: testObservedAt,
  });
  const inProgressReplay = await approve(runId, digest, expectedRevision, approvalKey);
  expect(inProgressReplay.response.status).toBe(202);
  expect(inProgressReplay.document).toEqual(inProgress.document);
  const changedInFlightReuse = await approve(runId, "0".repeat(64), expectedRevision, approvalKey);
  expect(changedInFlightReuse.response.status).toBe(409);
  expect(changedInFlightReuse.document).toMatchObject({
    code: "idempotency_key_reused",
  });
  for (const object of catalogueExport.objects) {
    const body = object.body();
    await Promise.all([
      testEnv.CATALOGUE_EXPORTS.put(object.key, body.readable, {
        sha256: object.sha256,
      }),
      body.completed,
    ]);
  }
  const listed = await testEnv.CATALOGUE_EXPORTS.list({
    prefix: `catalogue-exports/${revisionId}/`,
  });
  expect(listed.objects.map((object) => object.key).sort()).toEqual(
    [...new Set(catalogueExport.objects.map((object) => object.key))].sort(),
  );
  for (const object of catalogueExport.objects) {
    expect((await testEnv.CATALOGUE_EXPORTS.get(object.key))?.size).toBe(object.byteLength);
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
    export_manifest_digest: catalogueExport.manifest.manifest_sha256,
    publication_cleanup: null,
  });
  const replay = await approve(runId, digest, expectedRevision, approvalKey);
  expect(replay.response.status).toBe(200);
  expect(replay.document).toEqual(reconciled.document);
});

test("a stalled late publication write reopens completed cleanup when exact compensation fails", async () => {
  const startedAt = "2026-07-29T02:00:00.000Z";
  const reconcileAt = "2026-07-29T02:05:00.000Z";
  const cleanupAt = "2026-07-29T02:10:00.000Z";
  testObservedAt = startedAt;
  const priorCurrentRevision = await publishedCatalogueQueries
    .readCatalogueStateIdContentDigest(testEnv.CATALOGUE_DB)
    .first<{ id: string; content_digest: string }>();
  if (priorCurrentRevision !== null) {
    await publishedCatalogueQueries
      .setCatalogueRevisionsContentDigest(testEnv.CATALOGUE_DB)
      .bind("0".repeat(64), priorCurrentRevision.id)
      .run();
  }
  const started = await startRun("start-stalled-late-writer");
  const runId = requiredDocumentString(started.document, "id");
  const candidateDigest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const putStarted = deferred<string>();
  const releasePut = deferred<void>();
  let lateObjectKey: string | null = null;
  const stalledBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions,
    ) {
      lateObjectKey = key;
      putStarted.resolve(key);
      await releasePut.promise;
      return testEnv.CATALOGUE_EXPORTS.put(key, value, options);
    },
    async delete() {
      throw new Error("synthetic late compensation failure");
    },
  });
  const approval = approveRunDirect(
    catalogueStore(testEnv.CATALOGUE_DB),
    stalledBucket,
    runId,
    {
      candidate_digest: candidateDigest,
      expected_current_revision_id: expectedRevision,
      idempotency_key: "approve-stalled-late-writer",
    },
    startedAt,
  );
  await putStarted.promise;
  const identicalInFlight = await approve(runId, candidateDigest, expectedRevision, "approve-stalled-late-writer");
  expect(identicalInFlight.response.status).toBe(202);
  expect(identicalInFlight.document).toMatchObject({
    contract: "card-keepr-administration-operation@1",
    operation: "approve_ingestion_run",
    status: "in_progress",
    idempotency_key: "approve-stalled-late-writer",
  });
  const crossOperationReuse = await administrationRequest(`/v1/ingestion-runs/${runId}/rejection`, {
    candidate_digest: candidateDigest,
    idempotency_key: "approve-stalled-late-writer",
  });
  expect(crossOperationReuse.response.status).toBe(409);
  expect(crossOperationReuse.document).toMatchObject({
    code: "idempotency_key_reused",
  });
  testObservedAt = reconcileAt;
  const expiredClaimRecovery = await approve(runId, candidateDigest, expectedRevision, "approve-stalled-late-writer");
  expect(expiredClaimRecovery.response.status).toBe(500);
  expect(expiredClaimRecovery.document).toMatchObject({
    code: "publication_abandoned",
  });

  const failed = await showRunDirect(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.CATALOGUE_EXPORTS,
    runId,
    reconcileAt,
  );
  expect(failed).toMatchObject({
    state: "failed",
    publication_cleanup: { state: "pending", generation: 0 },
  });
  const completed = await retryPublicationCleanupDirect(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.CATALOGUE_EXPORTS,
    runId,
    { idempotency_key: "cleanup-before-late-write" },
    cleanupAt,
  );
  expect(completed).toMatchObject({
    publication_cleanup: { state: "completed" },
  });

  releasePut.resolve(undefined);
  await expect(approval).rejects.toMatchObject({
    code: "publication_abandoned",
  });
  expect(lateObjectKey).not.toBeNull();
  expect(await testEnv.CATALOGUE_EXPORTS.get(lateObjectKey!)).not.toBeNull();
  const reopened = await showRunDirect(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.CATALOGUE_EXPORTS,
    runId,
    cleanupAt,
  );
  expect(reopened).toMatchObject({
    publication_cleanup: {
      state: "failed",
      failure_code: "late_publication_write",
    },
  });
  await expect(
    retryPublicationCleanupDirect(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.CATALOGUE_EXPORTS,
      runId,
      { idempotency_key: "cleanup-before-late-write" },
      cleanupAt,
    ),
  ).rejects.toThrow("persisted administration success outcome does not match");
  const recovered = await retryPublicationCleanupDirect(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.CATALOGUE_EXPORTS,
    runId,
    { idempotency_key: "cleanup-after-late-write" },
    "2026-07-29T02:11:00.000Z",
  );
  expect(recovered).toMatchObject({
    publication_cleanup: { state: "completed" },
  });
  expect(await testEnv.CATALOGUE_EXPORTS.get(lateObjectKey!)).toBeNull();
  if (priorCurrentRevision !== null) {
    await publishedCatalogueQueries
      .setCatalogueRevisionsContentDigest(testEnv.CATALOGUE_DB)
      .bind(priorCurrentRevision.content_digest, priorCurrentRevision.id)
      .run();
  }
});

test("a cleanup CAS loser replays the immutable completion that won the race", async () => {
  const startedAt = "2026-07-29T02:30:00.000Z";
  testObservedAt = startedAt;
  const priorCurrentRevision = await publishedCatalogueQueries
    .readCatalogueStateIdContentDigest(testEnv.CATALOGUE_DB)
    .first<{ id: string; content_digest: string }>();
  if (priorCurrentRevision !== null) {
    await publishedCatalogueQueries
      .setCatalogueRevisionsContentDigest(testEnv.CATALOGUE_DB)
      .bind("0".repeat(64), priorCurrentRevision.id)
      .run();
  }
  const started = await startRun("start-cleanup-cas-replay");
  const runId = requiredDocumentString(started.document, "id");
  const failingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async put() {
      throw new Error("synthetic publication write failure");
    },
  });
  await expect(
    approveRunDirect(
      catalogueStore(testEnv.CATALOGUE_DB),
      failingBucket,
      runId,
      {
        candidate_digest: requiredDocumentString(started.document, "candidate_digest"),
        expected_current_revision_id: requiredDocumentString(started.document, "expected_current_revision_id"),
        idempotency_key: "approve-cleanup-cas-replay",
      },
      startedAt,
    ),
  ).rejects.toMatchObject({
    code: "export_verification_failed",
  });
  const failed = await showRunDirect(catalogueStore(testEnv.CATALOGUE_DB), testEnv.CATALOGUE_EXPORTS, runId, startedAt);
  const pendingCleanup = requiredDocumentRecord(failed, "publication_cleanup");
  const cleanupAt = requiredDocumentString(pendingCleanup, "not_before");
  const cleanupKey = "cleanup-cas-replay";
  const requestJson = JSON.stringify({ run_id: runId });
  const completed = {
    ...failed,
    publication_cleanup: {
      ...pendingCleanup,
      state: "completed",
      attempts: 1,
      failure_code: null,
      last_attempt_at: cleanupAt,
      completed_at: cleanupAt,
      generation: 2,
    },
  };
  let completedConcurrently = false;
  const racingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async list(options) {
      if (!completedConcurrently) {
        completedConcurrently = true;
        const administrationClaim = await ingestionQueries
          .readAdministrationIdempotencyClaimsOwnerTokenClaimVersion(testEnv.CATALOGUE_DB)
          .bind(cleanupKey)
          .first<{
            owner_token: string;
            claim_version: number;
          }>();
        if (administrationClaim === null) {
          throw new Error("cleanup administration claim is missing");
        }
        await catalogueStore(testEnv.CATALOGUE_DB).batch([
          ingestionQueries
            .setIngestionPublicationCleanupStateAttemptsForCleanupCASLoserReplaysImmutableCompletionThatWonRace(
              testEnv.CATALOGUE_DB,
            )
            .bind(cleanupAt, cleanupAt, cleanupKey, requestJson, runId),
          ingestionQueries
            .insertAdministrationIdempotencyForCleanupCASLoserReplaysImmutableCompletionThatWonRace(
              testEnv.CATALOGUE_DB,
            )
            .bind(
              cleanupKey,
              requestJson,
              JSON.stringify(completed),
              cleanupAt,
              administrationClaim.owner_token,
              administrationClaim.claim_version,
            ),
          ingestionQueries.deleteAdministrationIdempotencyClaims(testEnv.CATALOGUE_DB).bind(cleanupKey),
        ]);
      }
      return testEnv.CATALOGUE_EXPORTS.list(options);
    },
  });
  const replayed = await retryPublicationCleanupDirect(
    catalogueStore(testEnv.CATALOGUE_DB),
    racingBucket,
    runId,
    { idempotency_key: cleanupKey },
    cleanupAt,
  );
  expect(replayed).toEqual(completed);
  if (priorCurrentRevision !== null) {
    await publishedCatalogueQueries
      .setCatalogueRevisionsContentDigest(testEnv.CATALOGUE_DB)
      .bind(priorCurrentRevision.content_digest, priorCurrentRevision.id)
      .run();
  }
});

test("normal approval never adopts a prefix that becomes a registered export", async () => {
  const startedAt = "2026-07-29T02:40:00.000Z";
  testObservedAt = startedAt;
  const priorCurrentRevision = await publishedCatalogueQueries
    .readCatalogueStateIdContentDigest(testEnv.CATALOGUE_DB)
    .first<{ id: string; content_digest: string }>();
  if (priorCurrentRevision !== null) {
    await publishedCatalogueQueries
      .setCatalogueRevisionsContentDigest(testEnv.CATALOGUE_DB)
      .bind("0".repeat(64), priorCurrentRevision.id)
      .run();
  }
  const started = await startRun("start-normal-prefix-registration-race");
  const runId = requiredDocumentString(started.document, "id");
  const candidateDigest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const revisionId = await catalogueRevisionIdentity({
    runId,
    candidateDigest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const registeredManifestKey = `catalogue-exports/${revisionId}/registered-manifest.json`;
  const registeredBytes = new TextEncoder().encode("registered-export");
  await testEnv.CATALOGUE_EXPORTS.put(registeredManifestKey, registeredBytes);
  let registered = false;
  const racingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async put() {
      if (!registered) {
        registered = true;
        const run = await ingestionQueries
          .readIngestionRunsCandidateCatalogueDigest(testEnv.CATALOGUE_DB)
          .bind(runId)
          .first<{ candidate_catalogue_digest: string }>();
        await catalogueStore(testEnv.CATALOGUE_DB).batch([
          ingestionQueries
            .insertCatalogueRevisionsForNormalApprovalNeverAdoptsPrefixThatBecomesRegisteredExport(testEnv.CATALOGUE_DB)
            .bind(
              revisionId,
              runId,
              startedAt,
              run?.candidate_catalogue_digest ?? candidateDigest,
              expectedRevision,
              candidateDigest,
            ),
          catalogueExportQueries
            .insertCatalogueExports(testEnv.CATALOGUE_DB)
            .bind(revisionId, registeredManifestKey, "a".repeat(64)),
        ]);
      }
      throw new Error("the deterministic publication prefix became registered");
    },
  });

  await expect(
    approveRunDirect(
      catalogueStore(testEnv.CATALOGUE_DB),
      racingBucket,
      runId,
      {
        candidate_digest: candidateDigest,
        expected_current_revision_id: expectedRevision,
        idempotency_key: "approve-normal-prefix-registration-race",
      },
      startedAt,
    ),
  ).rejects.toMatchObject({ code: "publication_abandoned" });

  const stored = await ingestionQueries.countIngestionPublicationCleanupState(testEnv.CATALOGUE_DB).bind(runId).first<{
    state: string;
    cleanup_count: number;
    current_revision_id: string;
  }>();
  expect(stored).toEqual({
    state: "failed",
    cleanup_count: 0,
    current_revision_id: expectedRevision,
  });
  expect(
    await showRunDirect(catalogueStore(testEnv.CATALOGUE_DB), testEnv.CATALOGUE_EXPORTS, runId, startedAt),
  ).toMatchObject({
    state: "failed",
    failure_code: "publication_abandoned",
    publication_cleanup: null,
  });
  expect(
    await catalogueExportQueries
      .readCatalogueExportsCatalogueRevisionIdManifestKey(testEnv.CATALOGUE_DB)
      .bind(revisionId)
      .first(),
  ).toEqual({
    catalogue_revision_id: revisionId,
    manifest_key: registeredManifestKey,
    manifest_digest: "a".repeat(64),
    verified: 1,
  });
  expect(new Uint8Array(await (await testEnv.CATALOGUE_EXPORTS.get(registeredManifestKey))!.arrayBuffer())).toEqual(
    registeredBytes,
  );
  expect(
    (
      await testEnv.CATALOGUE_EXPORTS.list({
        prefix: `catalogue-exports/${revisionId}/`,
      })
    ).objects.map((object) => object.key),
  ).toEqual([registeredManifestKey]);
  if (priorCurrentRevision !== null) {
    await publishedCatalogueQueries
      .setCatalogueRevisionsContentDigest(testEnv.CATALOGUE_DB)
      .bind(priorCurrentRevision.content_digest, priorCurrentRevision.id)
      .run();
  }
});

test("cleanup deletes nothing when its failed prefix becomes registered", async () => {
  const startedAt = "2026-07-29T02:50:00.000Z";
  testObservedAt = startedAt;
  const priorCurrentRevision = await publishedCatalogueQueries
    .readCatalogueStateIdContentDigest(testEnv.CATALOGUE_DB)
    .first<{ id: string; content_digest: string }>();
  if (priorCurrentRevision !== null) {
    await publishedCatalogueQueries
      .setCatalogueRevisionsContentDigest(testEnv.CATALOGUE_DB)
      .bind("0".repeat(64), priorCurrentRevision.id)
      .run();
  }
  const started = await startRun("start-cleanup-prefix-registration-race");
  const runId = requiredDocumentString(started.document, "id");
  const candidateDigest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const revisionId = await catalogueRevisionIdentity({
    runId,
    candidateDigest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const failedObjectKey = `catalogue-exports/${revisionId}/partial-publication.bin`;
  const failedObjectBytes = new TextEncoder().encode("partial-publication");
  let failedAfterWrite = false;
  const failingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async put(...arguments_) {
      if (!failedAfterWrite) {
        failedAfterWrite = true;
        await testEnv.CATALOGUE_EXPORTS.put(failedObjectKey, failedObjectBytes);
        throw new Error("synthetic publication write failure");
      }
      return testEnv.CATALOGUE_EXPORTS.put(...arguments_);
    },
  });
  await expect(
    approveRunDirect(
      catalogueStore(testEnv.CATALOGUE_DB),
      failingBucket,
      runId,
      {
        candidate_digest: candidateDigest,
        expected_current_revision_id: expectedRevision,
        idempotency_key: "approve-cleanup-prefix-registration-race",
      },
      startedAt,
    ),
  ).rejects.toMatchObject({ code: "export_verification_failed" });
  const cleanup = await ingestionQueries
    .readIngestionPublicationCleanupNotBefore(testEnv.CATALOGUE_DB)
    .bind(runId)
    .first<{ not_before: string }>();
  // Inject the concurrent registration directly; normal publication owns its
  // guard in the repository and cannot create this deliberately conflicting fixture.
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries
      .insertCatalogueRevisionsForNormalApprovalNeverAdoptsPrefixThatBecomesRegisteredExport(testEnv.CATALOGUE_DB)
      .bind(revisionId, runId, startedAt, candidateDigest, expectedRevision, candidateDigest),
    catalogueExportQueries
      .insertCatalogueExports(testEnv.CATALOGUE_DB)
      .bind(revisionId, failedObjectKey, "b".repeat(64)),
  ]);

  await expect(
    retryPublicationCleanupDirect(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.CATALOGUE_EXPORTS,
      runId,
      { idempotency_key: "cleanup-prefix-registration-race" },
      cleanup?.not_before ?? "2026-07-29T03:00:00.000Z",
    ),
  ).rejects.toMatchObject({ code: "publication_cleanup_failed" });
  expect(new Uint8Array(await (await testEnv.CATALOGUE_EXPORTS.get(failedObjectKey))!.arrayBuffer())).toEqual(
    failedObjectBytes,
  );
  expect(
    await catalogueExportQueries
      .readCatalogueExportsCatalogueRevisionIdManifestKey(testEnv.CATALOGUE_DB)
      .bind(revisionId)
      .first(),
  ).toEqual({
    catalogue_revision_id: revisionId,
    manifest_key: failedObjectKey,
    manifest_digest: "b".repeat(64),
    verified: 1,
  });
  expect(await publishedCatalogueQueries.readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB).first()).toEqual({
    current_revision_id: expectedRevision,
  });
  if (priorCurrentRevision !== null) {
    await publishedCatalogueQueries
      .setCatalogueRevisionsContentDigest(testEnv.CATALOGUE_DB)
      .bind(priorCurrentRevision.content_digest, priorCurrentRevision.id)
      .run();
  }
});

test("unexpected recovery keys fail publication and are all removed by cleanup", async () => {
  testObservedAt = "2026-07-29T03:00:00.000Z";
  const before = await administrationRequest("/v1/status");
  const beforeDiagnostics = requiredDocumentRecord(before.document, "diagnostics");
  const beforeObjectCount = requiredDocumentNumber(beforeDiagnostics, "catalogue_export_object_count");
  const started = await startRun("start-unexpected-recovery-key");
  const runId = requiredDocumentString(started.document, "id");
  const digest = requiredDocumentString(started.document, "candidate_digest");
  const expectedRevision = requiredDocumentString(started.document, "expected_current_revision_id");
  const revisionId = await catalogueRevisionIdentity({
    runId,
    candidateDigest: digest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const approvalKey = "approve-unexpected-recovery-key";
  const approval = {
    action: "approved",
    approved_at: testObservedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  const candidate = await fixtureCandidate("first-catalogue", ["one-piece"]);
  const catalogueExport = await buildCatalogueExport(candidate.candidate, digest, revisionId, testObservedAt);
  for (const object of catalogueExport.objects) {
    const body = object.body();
    await Promise.all([
      testEnv.CATALOGUE_EXPORTS.put(object.key, body.readable, {
        sha256: object.sha256,
      }),
      body.completed,
    ]);
  }
  await testEnv.CATALOGUE_EXPORTS.put(`catalogue-exports/${revisionId}/unexpected.bin`, new Uint8Array([1, 2, 3]));
  const reconcileAfter = "2026-07-29T03:05:00.000Z";
  await ingestionQueries
    .setIngestionRunsStateApprovalJson(testEnv.CATALOGUE_DB)
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval"],
        current_stage: "publishing",
      }),
      revisionId,
      testObservedAt,
      reconcileAfter,
      catalogueExport.manifest.manifest_sha256,
      `writer:${revisionId}`,
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
  await testEnv.CATALOGUE_EXPORTS.put(`catalogue-exports/${revisionId}/late-unexpected.bin`, new Uint8Array([4, 5, 6]));
  const fencedCleanup = await administrationRequest(`/v1/ingestion-runs/${runId}/publication-cleanup`, {
    idempotency_key: "cleanup-unexpected-recovery-key",
  });
  expect(fencedCleanup.response.status).toBe(409);
  expect(fencedCleanup.document).toMatchObject({
    code: "publication_cleanup_fenced",
  });
  await testEnv.CATALOGUE_EXPORTS.put(`catalogue-exports/${revisionId}/late-in-flight.bin`, new Uint8Array([7, 8, 9]));
  await Promise.all(
    Array.from({ length: 1_001 }, (_, index) =>
      testEnv.CATALOGUE_EXPORTS.put(
        `catalogue-exports/${revisionId}/bulk-late-${String(index).padStart(4, "0")}.bin`,
        new Uint8Array([index % 256]),
      ),
    ),
  );
  testObservedAt = "2026-07-29T03:10:00.000Z";
  const cleanup = await administrationRequest(`/v1/ingestion-runs/${runId}/publication-cleanup`, {
    idempotency_key: "cleanup-unexpected-recovery-key",
  });
  expect(cleanup.document).toMatchObject({
    publication_cleanup: { state: "completed" },
  });
  const after = await administrationRequest("/v1/status");
  const afterDiagnostics = requiredDocumentRecord(after.document, "diagnostics");
  expect(requiredDocumentNumber(afterDiagnostics, "catalogue_export_object_count")).toBe(beforeObjectCount);
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
    requiredDocumentString(first.document, "expected_current_revision_id"),
    "approve-first-publication",
  );
  const revisionId = requiredDocumentString(firstPublished.document, "resulting_revision_id");
  const retry = await administrationRequest(
    `/v1/ingestion-runs/${requiredDocumentString(firstPublished.document, "id")}/retry`,
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
  expect(unchanged.document.freshness_checked_at).toEqual(expect.any(String));

  const status = await administrationRequest("/v1/status");
  expect(status.response.status).toBe(200);
  expect(status.document).toMatchObject({
    contract: "card-keepr-administration-status@1",
    production_target: {
      cloudflare_account_id: testEnv.CLOUDFLARE_ACCOUNT_ID,
      worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
      d1_databases: [
        {
          name: "card-keepr-catalogue",
          id: testEnv.CATALOGUE_D1_DATABASE_ID,
        },
        {
          name: "card-keepr-disposable-verification",
          id: testEnv.DISPOSABLE_D1_DATABASE_ID,
        },
      ],
      r2_buckets: [
        "card-keepr-evidence",
        "card-keepr-printing-images",
        "card-keepr-catalogue-exports",
        "card-keepr-backups",
      ],
    },
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
  const repairableRevisions = status.document.repairable_catalogue_revision_ids;
  if (!Array.isArray(repairableRevisions)) {
    throw new Error("status retained revision chain is invalid");
  }
  expect(repairableRevisions[0]).toBe(revisionId);
  expect(repairableRevisions.length).toBeGreaterThanOrEqual(1);
  expect(repairableRevisions.length).toBeLessThanOrEqual(3);
  expect(repairableRevisions).not.toContain("catrev_spine_000");
  const diagnostics = status.document.diagnostics;
  const expectedNewRevision = firstPublished.document.publication_outcome === "revision" ? 1 : 0;
  expect(diagnostics).toMatchObject({
    catalogue_revision_count: beforeDiagnostics.catalogue_revision_count + expectedNewRevision,
    catalogue_export_count: beforeDiagnostics.catalogue_export_count + expectedNewRevision,
  });
});

test("Catalogue Export deletion plans bind an exact immutable set and delete an older export manifest last", async () => {
  const oldRevision = "catrev_delete_old";
  const currentRevision = "catrev_delete_current";
  const old = await seedDeletionExport(oldRevision, "run_delete_old", "2026-08-05T00:00:00.000Z");
  const current = await seedDeletionExport(currentRevision, "run_delete_current", "2026-08-05T00:01:00.000Z");
  await testEnv.CATALOGUE_EXPORTS.put("catalogue-exports/catrev_unrelated/retained.bin", "retained");
  await testEnv.EVIDENCE_OBJECTS.put("source-snapshots/export-deletion-retained.json", "retained evidence");
  await testEnv.BACKUPS.put("d1-backups/export-deletion-retained.sql", "retained backup");
  const unexpectedKey = `catalogue-exports/${oldRevision}/unexpected.bin`;
  await testEnv.CATALOGUE_EXPORTS.put(unexpectedKey, "not in manifest");

  testObservedAt = "2026-08-05T01:00:00.000Z";
  const unsafe = await administrationRequest("/v1/catalogue-export-deletion-plans", {
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    plan_id: "export-delete-plan-unsafe",
  });
  expect(unsafe.response.status).toBe(409);
  expect(unsafe.document).toMatchObject({ code: "unsafe_export_object_scope" });
  await testEnv.CATALOGUE_EXPORTS.delete(unexpectedKey);
  const prepared = await administrationRequest("/v1/catalogue-export-deletion-plans", {
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    plan_id: "export-delete-plan-old",
  });
  expect(prepared.response.status).toBe(201);
  expect(prepared.document).toMatchObject({
    contract: "card-keepr-catalogue-export-deletion-plan@1",
    id: "export-delete-plan-old",
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    object_keys: old.objectKeys,
    object_set_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    plan_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    created_at: "2026-08-05T01:00:00.000Z",
    expires_at: "2026-08-05T01:15:00.000Z",
    dependencies: expect.arrayContaining([
      expect.objectContaining({
        code: "catalogue_consumers_may_depend",
        severity: "warning",
      }),
      expect.objectContaining({
        code: "authenticated_urls_will_return_410",
        severity: "warning",
      }),
    ]),
  });

  const currentPlan = await administrationRequest("/v1/catalogue-export-deletion-plans", {
    catalogue_revision_id: currentRevision,
    manifest_digest: current.manifestDigest,
    expected_current_revision_id: currentRevision,
    plan_id: "export-delete-plan-current",
  });
  expect(currentPlan.response.status).toBe(201);
  expect(currentPlan.document).toMatchObject({
    dependencies: expect.arrayContaining([
      expect.objectContaining({
        code: "current_catalogue_revision",
        severity: "blocking",
      }),
    ]),
  });
  const blockedCurrent = await administrationRequest("/v1/catalogue-export-deletions", {
    plan_id: currentPlan.document.id,
    plan_digest: currentPlan.document.plan_digest,
    catalogue_revision_id: currentRevision,
    manifest_digest: current.manifestDigest,
    expected_current_revision_id: currentRevision,
    confirmation_revision_id: currentRevision,
    deletion_id: "export-deletion-current",
    idempotency_key: "export-deletion-current-key",
  });
  expect(blockedCurrent.response.status).toBe(409);
  expect(blockedCurrent.document).toMatchObject({ code: "current_export_required" });

  testObservedAt = "2026-08-05T01:15:00.000Z";
  const expired = await administrationRequest("/v1/catalogue-export-deletions", {
    plan_id: prepared.document.id,
    plan_digest: prepared.document.plan_digest,
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    confirmation_revision_id: oldRevision,
    deletion_id: "export-deletion-expired",
    idempotency_key: "export-deletion-expired-key",
  });
  expect(expired.response.status).toBe(409);
  expect(expired.document).toMatchObject({ code: "deletion_plan_expired" });
  testObservedAt = "2026-08-05T01:01:00.000Z";

  const confirmed = await administrationRequest("/v1/catalogue-export-deletions", {
    plan_id: prepared.document.id,
    plan_digest: prepared.document.plan_digest,
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    confirmation_revision_id: oldRevision,
    deletion_id: "export-deletion-old",
    idempotency_key: "export-deletion-old-key",
  });
  expect(confirmed.response.status).toBe(200);
  expect(confirmed.document).toMatchObject({
    contract: "card-keepr-catalogue-export-deletion@1",
    id: "export-deletion-old",
    plan_id: "export-delete-plan-old",
    state: "deleted",
    catalogue_revision_id: oldRevision,
    object_set_digest: prepared.document.object_set_digest,
    failure_code: null,
    completed_at: expect.any(String),
  });
  await expect(testEnv.CATALOGUE_EXPORTS.list({ prefix: `catalogue-exports/${oldRevision}/` })).resolves.toMatchObject({
    objects: [],
  });
  await expect(
    testEnv.CATALOGUE_EXPORTS.get("catalogue-exports/catrev_unrelated/retained.bin"),
  ).resolves.not.toBeNull();
  await expect(testEnv.EVIDENCE_OBJECTS.get("source-snapshots/export-deletion-retained.json")).resolves.not.toBeNull();
  await expect(testEnv.BACKUPS.get("d1-backups/export-deletion-retained.sql")).resolves.not.toBeNull();
  const replayed = await administrationRequest("/v1/catalogue-export-deletions", {
    plan_id: prepared.document.id,
    plan_digest: prepared.document.plan_digest,
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    confirmation_revision_id: oldRevision,
    deletion_id: "export-deletion-old",
    idempotency_key: "export-deletion-old-key",
  });
  expect(replayed.response.status).toBe(200);
  expect(replayed.document).toEqual(confirmed.document);
});

test("concurrent exact deletion confirmation executes R2 once and replays one response", async () => {
  const oldRevision = "catrev_delete_concurrent_confirm";
  const currentRevision = "catrev_delete_concurrent_confirm_current";
  const old = await seedDeletionExport(oldRevision, "run_delete_concurrent_confirm", "2026-08-05T01:00:00.000Z");
  await seedDeletionExport(currentRevision, "run_delete_concurrent_confirm_current", "2026-08-05T01:01:00.000Z");
  testObservedAt = "2026-08-05T01:30:00.000Z";
  const prepared = await administrationRequest("/v1/catalogue-export-deletion-plans", {
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    plan_id: "export-delete-plan-concurrent-confirm",
  });
  const request = {
    plan_id: prepared.document.id,
    plan_digest: prepared.document.plan_digest,
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    confirmation_revision_id: oldRevision,
    deletion_id: "export-deletion-concurrent-confirm",
    idempotency_key: "export-deletion-concurrent-confirm-key",
  };
  const entered = deferred<void>();
  const release = deferred<void>();
  const pausedBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async delete(key) {
      entered.resolve(undefined);
      await release.promise;
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
  });
  const firstPromise = administrationRequestWithEnv("/v1/catalogue-export-deletions", request, {
    ...testEnv,
    CATALOGUE_EXPORTS: pausedBucket,
  });
  await entered.promise;
  let replayR2Calls = 0;
  const replayBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async head(key) {
      replayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.head(key);
    },
    async delete(key) {
      replayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
    async list(options) {
      replayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.list(options);
    },
  });
  const countedReplayDatabase = countDeletionResponseQueriesDatabase(testEnv.CATALOGUE_DB);
  const acceptedReplay = await administrationRequestWithEnv("/v1/catalogue-export-deletions", request, {
    ...testEnv,
    CATALOGUE_DB: countedReplayDatabase.database,
    CATALOGUE_EXPORTS: replayBucket,
  });
  expect(acceptedReplay.response.status).toBe(202);
  expect(acceptedReplay.document).toMatchObject({
    contract: "card-keepr-catalogue-export-deletion@1",
    id: "export-deletion-concurrent-confirm",
    state: "deleting",
    completed_at: null,
    failure_code: null,
  });
  expect(countedReplayDatabase.responseQueries()).toBeLessThanOrEqual(8);
  expect(replayR2Calls).toBe(0);
  release.resolve(undefined);
  const first = await firstPromise;
  expect(first.response.status).toBe(202);
  expect(first.document).toEqual(acceptedReplay.document);
  const laterReplay = await administrationRequest("/v1/catalogue-export-deletions", request);
  expect(laterReplay.response.status).toBe(202);
  expect(laterReplay.document).toEqual(acceptedReplay.document);
  const status = await administrationRequest("/v1/catalogue-export-deletions/export-deletion-concurrent-confirm");
  expect(status.document).toMatchObject({
    state: "deleted",
    completed_at: expect.any(String),
    failure_code: null,
  });
  expect(replayR2Calls).toBe(0);
});

test("a partial Catalogue Export deletion stays unavailable and retries only its original object set", async () => {
  const oldRevision = "catrev_delete_partial";
  const currentRevision = "catrev_delete_partial_current";
  const old = await seedDeletionExport(oldRevision, "run_delete_partial", "2026-08-05T02:00:00.000Z");
  await seedDeletionExport(currentRevision, "run_delete_partial_current", "2026-08-05T02:01:00.000Z");
  testObservedAt = "2026-08-05T03:00:00.000Z";
  const prepared = await administrationRequest("/v1/catalogue-export-deletion-plans", {
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    plan_id: "export-delete-plan-partial",
  });
  const deletedKeys: string[] = [];
  const manifestKey = old.objectKeys.at(-1)!;
  const failingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async delete(key) {
      deletedKeys.push(String(key));
      if (key === manifestKey) throw new Error("injected manifest delete failure");
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
  });
  const failed = await administrationRequestWithEnv(
    "/v1/catalogue-export-deletions",
    {
      plan_id: prepared.document.id,
      plan_digest: prepared.document.plan_digest,
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      confirmation_revision_id: oldRevision,
      deletion_id: "export-deletion-partial",
      idempotency_key: "export-deletion-partial-key",
    },
    { ...testEnv, CATALOGUE_EXPORTS: failingBucket },
  );
  expect(failed.response.status).toBe(200);
  expect(failed.document).toMatchObject({
    state: "failed",
    object_set_digest: prepared.document.object_set_digest,
    failure_code: "deleted_object_set_mismatch",
  });
  expect(deletedKeys.at(-1)).toBe(manifestKey);
  await expect(testEnv.CATALOGUE_EXPORTS.head(manifestKey)).resolves.not.toBeNull();

  const status = await administrationRequest("/v1/catalogue-export-deletions/export-deletion-partial");
  expect(status.document).toEqual(failed.document);
  const retryEntered = deferred<void>();
  const releaseRetry = deferred<void>();
  const pausedRetryBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async delete(key) {
      retryEntered.resolve(undefined);
      await releaseRetry.promise;
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
  });
  const retryPromise = administrationRequestWithEnv(
    "/v1/catalogue-export-deletions/export-deletion-partial/retry",
    {
      object_set_digest: prepared.document.object_set_digest,
      idempotency_key: "export-deletion-partial-retry-key",
    },
    { ...testEnv, CATALOGUE_EXPORTS: pausedRetryBucket },
  );
  await retryEntered.promise;
  const confirmationDuringRetry = await administrationRequest("/v1/catalogue-export-deletions", {
    plan_id: prepared.document.id,
    plan_digest: prepared.document.plan_digest,
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    confirmation_revision_id: oldRevision,
    deletion_id: "export-deletion-partial",
    idempotency_key: "export-deletion-partial-key",
  });
  expect(confirmationDuringRetry.document).toEqual(failed.document);
  let exactRetryReplayR2Calls = 0;
  const exactRetryReplayBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async head(key) {
      exactRetryReplayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.head(key);
    },
    async delete(key) {
      exactRetryReplayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
    async list(options) {
      exactRetryReplayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.list(options);
    },
  });
  const exactRetryReplayPromise = administrationRequestWithEnv(
    "/v1/catalogue-export-deletions/export-deletion-partial/retry",
    {
      object_set_digest: prepared.document.object_set_digest,
      idempotency_key: "export-deletion-partial-retry-key",
    },
    { ...testEnv, CATALOGUE_EXPORTS: exactRetryReplayBucket },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(exactRetryReplayR2Calls).toBe(0);
  let losingRetryR2Calls = 0;
  const losingRetryBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async head(key) {
      losingRetryR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.head(key);
    },
    async delete(key) {
      losingRetryR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
    async list(options) {
      losingRetryR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.list(options);
    },
  });
  const losingRetry = await administrationRequestWithEnv(
    "/v1/catalogue-export-deletions/export-deletion-partial/retry",
    {
      object_set_digest: prepared.document.object_set_digest,
      idempotency_key: "export-deletion-partial-losing-key",
    },
    { ...testEnv, CATALOGUE_EXPORTS: losingRetryBucket },
  );
  expect(losingRetry.response.status).toBe(409);
  expect(losingRetry.document).toMatchObject({
    code: "export_deletion_not_failed",
  });
  expect(losingRetryR2Calls).toBe(0);
  const concurrentExactRetry = await exactRetryReplayPromise;
  expect(concurrentExactRetry.response.status).toBe(202);
  expect(concurrentExactRetry.document).toMatchObject({
    state: "deleting",
    completed_at: null,
    failure_code: null,
  });
  expect(exactRetryReplayR2Calls).toBe(0);
  releaseRetry.resolve(undefined);
  const retried = await retryPromise;
  expect(retried.response.status).toBe(202);
  expect(concurrentExactRetry.document).toEqual(retried.document);
  const terminalStatus = await administrationRequest("/v1/catalogue-export-deletions/export-deletion-partial");
  expect(terminalStatus.document).toMatchObject({
    state: "deleted",
    object_set_digest: prepared.document.object_set_digest,
    failure_code: null,
  });
  const retryReplay = await administrationRequest("/v1/catalogue-export-deletions/export-deletion-partial/retry", {
    object_set_digest: prepared.document.object_set_digest,
    idempotency_key: "export-deletion-partial-retry-key",
  });
  expect(retryReplay.response.status).toBe(202);
  expect(retryReplay.document).toEqual(retried.document);
  const confirmationReplay = await administrationRequest("/v1/catalogue-export-deletions", {
    plan_id: prepared.document.id,
    plan_digest: prepared.document.plan_digest,
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    confirmation_revision_id: oldRevision,
    deletion_id: "export-deletion-partial",
    idempotency_key: "export-deletion-partial-key",
  });
  expect(confirmationReplay.document).toEqual(failed.document);
});

test("an exact confirmation replay resumes an interrupted deleting operation", async () => {
  const oldRevision = "catrev_delete_interrupted";
  const currentRevision = "catrev_delete_interrupted_current";
  const old = await seedDeletionExport(oldRevision, "run_delete_interrupted", "2026-08-05T04:00:00.000Z");
  await seedDeletionExport(currentRevision, "run_delete_interrupted_current", "2026-08-05T04:01:00.000Z");
  testObservedAt = "2026-08-05T05:00:00.000Z";
  const prepared = await administrationRequest("/v1/catalogue-export-deletion-plans", {
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    plan_id: "export-delete-plan-interrupted",
  });
  const request = {
    plan_id: String(prepared.document.id),
    plan_digest: String(prepared.document.plan_digest),
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    confirmation_revision_id: oldRevision,
    deletion_id: "export-deletion-interrupted",
    idempotency_key: "export-deletion-interrupted-key",
  };
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    catalogueExportQueries
      .insertCatalogueExportDeletionsForExactConfirmationReplayResumesInterruptedDeletingOperation(testEnv.CATALOGUE_DB)
      .bind(
        request.deletion_id,
        request.plan_id,
        oldRevision,
        old.manifestDigest,
        currentRevision,
        prepared.document.object_set_digest,
        request.idempotency_key,
        canonicalJson(request),
        testObservedAt,
      ),
    catalogueExportQueries
      .setCatalogueExportsMaintenanceStateDeletionOperationIdForExactConfirmationReplayResumesInterruptedDeletingOperation(
        testEnv.CATALOGUE_DB,
      )
      .bind(request.deletion_id, oldRevision),
  ]);

  const resumed = await administrationRequest("/v1/catalogue-export-deletions", request);
  expect(resumed.response.status).toBe(200);
  expect(resumed.document).toMatchObject({
    id: request.deletion_id,
    state: "deleted",
    object_set_digest: prepared.document.object_set_digest,
  });
  await expect(
    testEnv.CATALOGUE_EXPORTS.list({
      prefix: `catalogue-exports/${oldRevision}/`,
    }),
  ).resolves.toMatchObject({ objects: [] });
});

test("a stale Catalogue Export deletion retry stops R2 after lease takeover", async () => {
  const oldRevision = "catrev_delete_lease_takeover";
  const currentRevision = "catrev_delete_lease_takeover_current";
  const old = await seedDeletionExport(oldRevision, "run_delete_lease_takeover", "2026-08-05T05:30:00.000Z");
  await seedDeletionExport(currentRevision, "run_delete_lease_takeover_current", "2026-08-05T05:31:00.000Z");
  testObservedAt = "2026-08-05T06:00:00.000Z";
  const prepared = await administrationRequest("/v1/catalogue-export-deletion-plans", {
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    plan_id: "export-delete-plan-lease-takeover",
  });
  const manifestKey = old.objectKeys.at(-1)!;
  const failingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async delete(key) {
      if (key === manifestKey) throw new Error("injected deletion failure");
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
  });
  const failed = await administrationRequestWithEnv(
    "/v1/catalogue-export-deletions",
    {
      plan_id: prepared.document.id,
      plan_digest: prepared.document.plan_digest,
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      confirmation_revision_id: oldRevision,
      deletion_id: "export-deletion-lease-takeover",
      idempotency_key: "export-deletion-lease-takeover-confirm",
    },
    { ...testEnv, CATALOGUE_EXPORTS: failingBucket },
  );
  expect(failed.document).toMatchObject({ state: "failed" });

  const pausedDatabase = pauseBeforeThirdDeletionBatchDatabase(testEnv.CATALOGUE_DB);
  let staleHeadCalls = 0;
  let staleDeleteCalls = 0;
  const staleBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async head(key) {
      staleHeadCalls += 1;
      return testEnv.CATALOGUE_EXPORTS.head(key);
    },
    async delete(key) {
      staleDeleteCalls += 1;
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
  });
  const retryRequest = {
    object_set_digest: prepared.document.object_set_digest,
    idempotency_key: "export-deletion-lease-takeover-retry",
  };
  const stalePromise = administrationRequestWithEnv(
    "/v1/catalogue-export-deletions/export-deletion-lease-takeover/retry",
    retryRequest,
    {
      ...testEnv,
      CATALOGUE_DB: pausedDatabase.database,
      CATALOGUE_EXPORTS: staleBucket,
    },
  );
  await pausedDatabase.entered;
  expect(staleHeadCalls).toBe(1);
  expect(staleDeleteCalls).toBe(0);
  await catalogueExportQueries
    .setCatalogueExportDeletionsExecutionLeaseExpiresAt(testEnv.CATALOGUE_DB)
    .bind("2026-08-05T05:59:59.000Z", "export-deletion-lease-takeover")
    .run();

  const winner = await administrationRequest(
    "/v1/catalogue-export-deletions/export-deletion-lease-takeover/retry",
    retryRequest,
  );
  expect(winner.document).toMatchObject({ state: "deleted" });
  pausedDatabase.release();
  const stale = await stalePromise;
  expect(stale.document).toEqual(winner.document);
  expect(staleHeadCalls).toBe(1);
  expect(staleDeleteCalls).toBe(0);
});

test("a crashed failed retry remains stable after another key succeeds", async () => {
  const oldRevision = "catrev_delete_retry_crash";
  const currentRevision = "catrev_delete_retry_crash_current";
  const old = await seedDeletionExport(oldRevision, "run_delete_retry_crash", "2026-08-05T06:00:00.000Z");
  await seedDeletionExport(currentRevision, "run_delete_retry_crash_current", "2026-08-05T06:01:00.000Z");
  testObservedAt = "2026-08-05T07:00:00.000Z";
  const prepared = await administrationRequest("/v1/catalogue-export-deletion-plans", {
    catalogue_revision_id: oldRevision,
    manifest_digest: old.manifestDigest,
    expected_current_revision_id: currentRevision,
    plan_id: "export-delete-plan-retry-crash",
  });
  const manifestKey = old.objectKeys.at(-1)!;
  const failingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async delete(key) {
      if (key === manifestKey) throw new Error("injected deletion failure");
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
  });
  const failed = await administrationRequestWithEnv(
    "/v1/catalogue-export-deletions",
    {
      plan_id: prepared.document.id,
      plan_digest: prepared.document.plan_digest,
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      confirmation_revision_id: oldRevision,
      deletion_id: "export-deletion-retry-crash",
      idempotency_key: "export-deletion-retry-crash-confirm",
    },
    { ...testEnv, CATALOGUE_EXPORTS: failingBucket },
  );
  expect(failed.document).toMatchObject({ state: "failed" });

  const crashDatabase = crashAfterRetryTerminalDatabase(testEnv.CATALOGUE_DB);
  const failedCrash = await administrationRequestWithEnv(
    "/v1/catalogue-export-deletions/export-deletion-retry-crash/retry",
    {
      object_set_digest: prepared.document.object_set_digest,
      idempotency_key: "export-deletion-retry-crash-failed-key",
    },
    {
      ...testEnv,
      CATALOGUE_DB: crashDatabase,
      CATALOGUE_EXPORTS: failingBucket,
    },
  );
  expect(failedCrash.response.status).toBe(500);
  await expect(testEnv.CATALOGUE_EXPORTS.head(manifestKey)).resolves.not.toBeNull();

  const succeeded = await administrationRequest("/v1/catalogue-export-deletions/export-deletion-retry-crash/retry", {
    object_set_digest: prepared.document.object_set_digest,
    idempotency_key: "export-deletion-retry-crash-success-key",
  });
  expect(succeeded.document).toMatchObject({
    state: "deleted",
    failure_code: null,
  });

  let failedReplayR2Calls = 0;
  const observingFailedBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async head(key) {
      failedReplayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.head(key);
    },
    async delete(key) {
      failedReplayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.delete(key);
    },
    async list(options) {
      failedReplayR2Calls += 1;
      return testEnv.CATALOGUE_EXPORTS.list(options);
    },
  });
  const failedReplay = await administrationRequestWithEnv(
    "/v1/catalogue-export-deletions/export-deletion-retry-crash/retry",
    {
      object_set_digest: prepared.document.object_set_digest,
      idempotency_key: "export-deletion-retry-crash-failed-key",
    },
    { ...testEnv, CATALOGUE_EXPORTS: observingFailedBucket },
  );
  expect(failedReplay.document).toEqual(failed.document);
  expect(failedReplayR2Calls).toBe(0);
});

async function administrationRequest(
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  if (pathname === "/v1/ingestion-runs" && body !== undefined) {
    try {
      const document = await injectFixturePublication(
        testEnv.CATALOGUE_DB,
        testEnv.CATALOGUE_EXPORTS,
        {
          fixture: String(body.fixture),
          selected_games: Array.isArray(body.selected_games) ? body.selected_games.map(String) : [],
          idempotency_key: String(body.idempotency_key),
        },
        testObservedAt ?? undefined,
      );
      return {
        response: Response.json(document, {
          status:
            document.contract === "card-keepr-administration-operation@1" && document.status === "in_progress"
              ? 202
              : 201,
        }),
        document,
      };
    } catch (error) {
      const status = error instanceof AdministrationProblem ? error.status : 500;
      const code = error instanceof AdministrationProblem ? error.code : "internal_error";
      const document = {
        type: `https://card-keepr.invalid/problems/${code}`,
        title: "Administration request rejected",
        status,
        code,
        detail:
          error instanceof AdministrationProblem ? error.message : "The administration request could not be completed.",
        request_id: crypto.randomUUID(),
      };
      return {
        response: Response.json(document, { status }),
        document,
      };
    }
  }
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `192.0.2.${(requestSequence++ % 250) + 1}`,
        ...(testObservedAt === null ? {} : { "x-keepr-test-now": testObservedAt }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

async function administrationRequestWithEnv(
  pathname: string,
  body: Record<string, unknown>,
  requestEnv: Env,
): Promise<{ response: Response; document: Record<string, unknown> }> {
  const response = await ingestionWorker.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `192.0.2.${(requestSequence++ % 250) + 1}`,
        "content-type": "application/json",
        ...(testObservedAt === null ? {} : { "x-keepr-test-now": testObservedAt }),
      },
      body: JSON.stringify(body),
    }),
    requestEnv,
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

async function seedDeletionExport(
  revisionId: string,
  runId: string,
  publishedAt: string,
): Promise<{ manifestDigest: string; objectKeys: string[] }> {
  const candidate = await fixtureCandidate("first-catalogue", ["one-piece"]);
  const digest = candidate.digest;
  const previousRevisionId = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<string>("current_revision_id");
  if (previousRevisionId === null) throw new Error("missing catalogue state");
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    ingestionQueries.insertIngestionRunsForSeedDeletionExport(testEnv.CATALOGUE_DB).bind(
      runId,
      publishedAt,
      previousRevisionId,
      `${runId}-seed`,
      digest,
      publishedAt,
      JSON.stringify({
        action: "approved",
        candidate_digest: digest,
        expected_current_revision_id: previousRevisionId,
        approved_at: publishedAt,
      }),
      JSON.stringify(candidate.candidate),
    ),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(runId),
  ]);
  await ingestionQueries
    .insertCatalogueRevisionsForNormalApprovalNeverAdoptsPrefixThatBecomesRegisteredExport(testEnv.CATALOGUE_DB)
    .bind(revisionId, runId, publishedAt, digest, previousRevisionId, digest)
    .run();
  const manifestKey = `catalogue-exports/${revisionId}/manifest.json`;
  const componentKey = `catalogue-exports/${revisionId}/components/${digest}.ndjson.gz`;
  const manifestWithPlaceholder = {
    export_schema_major: 5,
    catalogue_revision: { id: revisionId, content_sha256: digest },
    components: [
      {
        name: "cards",
        compressed_sha256: digest,
        compressed_bytes: revisionId.length,
      },
    ],
    manifest_sha256: "0".repeat(64),
  };
  const manifestDigest = await sha256Text(`${canonicalJson(manifestWithPlaceholder)}\n`);
  const manifest = {
    ...manifestWithPlaceholder,
    manifest_sha256: manifestDigest,
  };
  await testEnv.CATALOGUE_EXPORTS.put(componentKey, revisionId);
  await testEnv.CATALOGUE_EXPORTS.put(manifestKey, `${canonicalJson(manifest)}\n`);
  await catalogueStore(testEnv.CATALOGUE_DB).batch([
    catalogueExportQueries.insertCatalogueExports(testEnv.CATALOGUE_DB).bind(revisionId, manifestKey, manifestDigest),
    publishedCatalogueQueries
      .setCatalogueStateCurrentRevisionIdPublishedAt(testEnv.CATALOGUE_DB)
      .bind(revisionId, publishedAt),
    ingestionQueries
      .setIngestionRunsStatePublishedRevisionIdForSeedDeletionExport(testEnv.CATALOGUE_DB)
      .bind(revisionId, revisionId, publishedAt, runId),
    ingestionQueries.setOperationStateActiveIngestionRunIdForSeedApiRevision(testEnv.CATALOGUE_DB).bind(runId),
  ]);
  return { manifestDigest, objectKeys: [componentKey, manifestKey] };
}

function startRun(idempotencyKey: string): Promise<{
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
  return administrationRequest(`/v1/ingestion-runs/${runId}/approval`, {
    candidate_digest: candidateDigest,
    expected_current_revision_id: expectedRevision,
    idempotency_key: idempotencyKey,
  });
}

function showRun(runId: string): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  return administrationRequest(`/v1/ingestion-runs/${runId}`);
}

function requiredDocumentString(document: Record<string, unknown>, field: string): string {
  const value = document[field];
  if (typeof value !== "string") {
    throw new Error(`${field} is not a string`);
  }
  return value;
}

function requiredDocumentRecord(document: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = document[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredDocumentNumber(document: Record<string, unknown>, field: string): number {
  const value = document[field];
  if (typeof value !== "number") {
    throw new Error(`${field} is not a number`);
  }
  return value;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise!(value);
    },
  };
}

function proxyR2Bucket(
  bucket: R2Bucket,
  overrides: {
    head?: (...arguments_: Parameters<R2Bucket["head"]>) => ReturnType<R2Bucket["head"]>;
    get?: (...arguments_: Parameters<R2Bucket["get"]>) => ReturnType<R2Bucket["get"]>;
    put?: (...arguments_: Parameters<R2Bucket["put"]>) => ReturnType<R2Bucket["put"]>;
    delete?: (...arguments_: Parameters<R2Bucket["delete"]>) => ReturnType<R2Bucket["delete"]>;
    list?: (...arguments_: Parameters<R2Bucket["list"]>) => ReturnType<R2Bucket["list"]>;
  },
): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      const override =
        property === "head"
          ? overrides.head
          : property === "get"
            ? overrides.get
            : property === "put"
              ? overrides.put
              : property === "delete"
                ? overrides.delete
                : property === "list"
                  ? overrides.list
                  : undefined;
      if (override !== undefined) return override;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function pauseBeforeThirdDeletionBatchDatabase(database: D1Database): {
  database: D1Database;
  entered: Promise<void>;
  release: () => void;
} {
  let batchCount = 0;
  const entered = deferred<void>();
  const release = deferred<void>();
  return {
    database: new Proxy(database, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchCount += 1;
            if (batchCount === 3) {
              entered.resolve(undefined);
              await release.promise;
            }
            return catalogueStore(target).batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    entered: entered.promise,
    release() {
      release.resolve(undefined);
    },
  };
}

async function fixtureRetryRequestJson(key: string): Promise<string> {
  return canonicalJson({
    source_run_id: await fixturePublicationSourceId({
      fixture: "first-catalogue",
      selected_games: ["one-piece"],
      idempotency_key: key,
    }),
  });
}
