import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import ingestionWorker from "../src/index";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import { fixtureCandidate } from "../../../src/catalogue/fixture";
import { catalogueRevisionIdentity } from "../../../src/catalogue/idempotent-identities";
import {
  canonicalJson,
  sha256Text,
} from "../../../src/catalogue/serialization";
import {
  AdministrationProblem,
  administrationStatus as administrationStatusDirect,
  approveRun as approveRunDirect,
  retryPublicationCleanup as retryPublicationCleanupDirect,
  showRun as showRunDirect,
} from "../../../src/catalogue/ingestion";
import { injectFixturePublication } from "./fixture-plan-injection";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
  LEGACY_DB: D1Database;
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

test("a legacy published run upgrades to the strict lifecycle representation without losing its approval audit", async () => {
  const legacyDatabase = testEnv.LEGACY_DB;
  await applyD1Migrations(legacyDatabase, [
    testEnv.TEST_MIGRATIONS[0]!,
  ]);
  const legacyRunId = "run_legacy_published";
  const legacyRevisionId = "catrev_legacy_published";
  const candidate = await fixtureCandidate("first-catalogue", [
    "one-piece",
  ]);
  const candidateCreatedAt = "2099-07-29T01:00:00.000Z";
  const approvedAt = "2099-07-29T01:01:00.000Z";
  const terminalAt = "2099-07-29T01:02:00.000Z";
  const deadline = "2099-08-05T01:00:00.000Z";
  const candidateDigest = candidate.digest;
  const manifestDigest = "b".repeat(64);
  const legacyApproval = {
    approved_at: approvedAt,
    candidate_digest: candidateDigest,
    expected_current_revision_id: "catrev_spine_000",
  };
  await legacyDatabase.batch([
    legacyDatabase
      .prepare(
        `INSERT INTO ingestion_runs (
          id,
          state,
          selected_games_json,
          started_at,
          expected_current_revision_id,
          linked_run_id,
          idempotency_key,
          candidate_digest,
          candidate_created_at,
          approval_deadline,
          approval_json,
          published_revision_id,
          export_manifest_digest,
          terminal_at,
          candidate_json,
          approval_idempotency_key
        ) VALUES (
          ?, 'awaiting_approval', ?, ?, 'catrev_spine_000',
          NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?
        )`,
      )
      .bind(
        legacyRunId,
        JSON.stringify(["one-piece"]),
        candidateCreatedAt,
        "start-legacy-published",
        candidateDigest,
        candidateCreatedAt,
        deadline,
        JSON.stringify(legacyApproval),
        JSON.stringify(candidate.candidate),
        "approve-legacy-published",
      ),
    legacyDatabase
      .prepare(
        `UPDATE operation_state
        SET active_ingestion_run_id = ?
        WHERE singleton = 1`,
      )
      .bind(legacyRunId),
  ]);
  await legacyDatabase
    .prepare(
      `INSERT INTO catalogue_revisions (
        id,
        ingestion_run_id,
        published_at,
        content_digest,
        expected_previous_revision_id,
        approved_candidate_digest
      ) VALUES (?, ?, ?, ?, 'catrev_spine_000', ?)`,
    )
    .bind(
      legacyRevisionId,
      legacyRunId,
      terminalAt,
      candidateDigest,
      candidateDigest,
    )
    .run();
  await legacyDatabase.batch([
    legacyDatabase
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'published',
            published_revision_id = ?,
            export_manifest_digest = ?,
            terminal_at = ?
        WHERE id = ?`,
      )
      .bind(
        legacyRevisionId,
        manifestDigest,
        terminalAt,
        legacyRunId,
      ),
    legacyDatabase
      .prepare(
        `UPDATE catalogue_state
        SET current_revision_id = ?,
            published_at = ?
        WHERE singleton = 1`,
      )
      .bind(legacyRevisionId, terminalAt),
    legacyDatabase.prepare(
      `UPDATE operation_state
      SET active_ingestion_run_id = NULL
      WHERE singleton = 1`,
    ),
  ]);

  await applyD1Migrations(legacyDatabase, [
    testEnv.TEST_MIGRATIONS[1]!,
  ]);
  const upgraded = await showRunDirect(
    legacyDatabase,
    testEnv.CATALOGUE_EXPORTS,
    legacyRunId,
    terminalAt,
  );
  expect(upgraded).toMatchObject({
    id: legacyRunId,
    state: "published",
    approval: {
      action: "approved",
      approved_at: approvedAt,
    },
    approval_history: [
      {
        action: "approved",
        approved_at: approvedAt,
      },
    ],
    freshness_checked_at: terminalAt,
    publication_reservation: {
      revision_id: legacyRevisionId,
      started_at: approvedAt,
      writer_token: `writer:${legacyRevisionId}`,
    },
    publication_cleanup: null,
  });
  await applyD1Migrations(
    legacyDatabase,
    testEnv.TEST_MIGRATIONS.slice(2),
  );
  const status = await administrationStatusDirect(
    legacyDatabase,
    testEnv.CATALOGUE_EXPORTS,
    terminalAt,
    {
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
  );
  expect(status).toMatchObject({
    source_freshness: [
      {
        game: "one-piece",
        area: "cards-and-printings",
        checked_at: terminalAt,
        ingestion_run_id: legacyRunId,
      },
    ],
  });
});

test("the public run boundary reads and retries an immutable fixed-point legacy candidate", async () => {
  const runId = "run_historical_fixed_point_candidate";
  const historicalCandidate = {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    cards: [{
      id: "card_01k_first_catalogue_0001",
      game: "one-piece",
      official_identity: {
        kind: "card_number",
        value: "OP01-001",
      },
      name: "Monkey.D.Luffy",
      effective_rules_text:
        "[DON!! x1] This Leader gains +1000 power during your turn.",
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
          effect_text:
            "[DON!! x1] This Leader gains +1000 power during your turn.",
          trigger_text: null,
        },
      },
    }],
    printings: [{
      id: "printing_01k_first_catalogue_0001",
      card_id: "card_01k_first_catalogue_0001",
      rarity: { normalized: "leader", raw: "L" },
      printed_rules_text:
        "[DON!! x1] This Leader gains +1000 power during your turn.",
      game_data: {
        profile: "one-piece@1",
        attributes: { illustration_types: [] },
      },
    }],
  } as const;
  const immutableCandidateJson = canonicalJson(historicalCandidate);
  const historicalDigest = await sha256Text(immutableCandidateJson);
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO ingestion_runs (
      id, state, selected_games_json, started_at,
      expected_current_revision_id, linked_run_id, idempotency_key,
      candidate_digest, candidate_created_at, approval_deadline,
      approval_json, published_revision_id, export_manifest_digest,
      terminal_at, candidate_json, approval_idempotency_key,
      failure_code, progress_json
    ) VALUES (
      ?, 'failed', '["one-piece"]', '2026-07-29T01:00:00.000Z',
      'catrev_spine_000', NULL, 'historical-fixed-point-seed',
      ?, '2026-07-29T01:00:00.000Z',
      '2026-08-05T01:00:00.000Z', NULL, NULL, NULL,
      '2026-07-29T01:02:00.000Z', ?, NULL,
      'legacy_ingestion_failure',
      '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}'
    )`,
  ).bind(runId, historicalDigest, immutableCandidateJson).run();

  const shown = await showRun(runId);
  expect(shown.response.status).toBe(200);
  expect(shown.document).toMatchObject({
    id: runId,
    state: "failed",
    candidate_digest: historicalDigest,
  });

  const retried = await administrationRequest(
    `/v1/ingestion-runs/${runId}/retry`,
    { idempotency_key: "retry-historical-fixed-point" },
  );
  expect(retried.response.status).toBe(201);
  expect(retried.document).toMatchObject({
    state: "awaiting_approval",
    linked_run_id: runId,
  });

  const persisted = await testEnv.CATALOGUE_DB.prepare(
    `SELECT id, candidate_json FROM ingestion_runs
     WHERE id IN (?, ?)
     ORDER BY id`,
  ).bind(runId, requiredDocumentString(retried.document, "id"))
    .all<{ id: string; candidate_json: string }>();
  const original = persisted.results.find((row) => row.id === runId);
  const replacement = persisted.results.find((row) => row.id !== runId);
  expect(original?.candidate_json).toBe(immutableCandidateJson);
  expect(JSON.parse(original!.candidate_json)).toHaveProperty(
    "fixture",
    "first-catalogue",
  );
  expect(JSON.parse(replacement!.candidate_json)).toHaveProperty(
    "contract",
    "card-keepr-catalogue-candidate@1",
  );
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
    new Request(
      "https://card-keepr.invalid/v1/ingestion-runs/evidence",
      {
        method: "POST",
        headers: {
          authorization: "Bearer vitest-administration-key",
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.251",
        },
        body,
      },
    ),
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

test("an orphaned start claim returns stable progress before its lease and resumes by CAS after expiry", async () => {
  const claimedAt = "2026-07-29T04:00:00.000Z";
  const expiresAt = "2026-07-29T04:05:00.000Z";
  const key = "start-orphaned-claim";
  const requestJson =
    `{"fixture":"first-catalogue","selected_games":["one-piece"]}`;
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO administration_idempotency_claims (
      idempotency_key,
      operation,
      request_json,
      claimed_at,
      owner_token,
      claim_version,
      claim_expires_at
    ) VALUES (?, 'start_ingestion_run', ?, ?, ?, 7, ?)`,
  )
    .bind(
      key,
      requestJson,
      claimedAt,
      "administration-claim:terminated-start",
      expiresAt,
    )
    .run();

  testObservedAt = "2026-07-29T04:01:00.000Z";
  const pending = await startRun(key);
  expect(pending.response.status).toBe(202);
  expect(pending.document).toMatchObject({
    contract: "card-keepr-administration-operation@1",
    operation: "start_ingestion_run",
    status: "in_progress",
    idempotency_key: key,
    claimed_at: claimedAt,
  });
  const pendingReplay = await startRun(key);
  expect(pendingReplay.document).toEqual(pending.document);
  const changed = await administrationRequest(
    "/v1/ingestion-runs",
    {
      fixture: "first-catalogue",
      selected_games: ["one-piece", "digimon"],
      idempotency_key: key,
    },
  );
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
  const remainingClaim = await testEnv.CATALOGUE_DB.prepare(
    `SELECT idempotency_key
    FROM administration_idempotency_claims
    WHERE idempotency_key = ?`,
  )
    .bind(key)
    .first();
  expect(remainingClaim).toBeNull();
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

  testObservedAt = new Date(
    Date.parse(deadline) + 2 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const replacement = await startRun("start-after-expiry");
  expect(replacement.response.status).toBe(201);
  const expired = await showRun(runId);
  expect(expired.document).toMatchObject({
    state: "expired",
    terminal_at: deadline,
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
        publication_manifest_digest = ?,
        publication_writer_token = ?
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
      `writer:${revisionId}`,
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
  await testEnv.CATALOGUE_EXPORTS.put(
    `catalogue-exports/${revisionId}/abandoned.bin`,
    new Uint8Array([1]),
  );
  const deleteStarted = deferred<void>();
  const releaseDelete = deferred<void>();
  const stalledCleanupBucket = proxyR2Bucket(
    testEnv.CATALOGUE_EXPORTS,
    {
      async delete(keys) {
        deleteStarted.resolve(undefined);
        await releaseDelete.promise;
        return testEnv.CATALOGUE_EXPORTS.delete(keys);
      },
    },
  );
  const staleCleanup = retryPublicationCleanupDirect(
    testEnv.CATALOGUE_DB,
    stalledCleanupBucket,
    runId,
    { idempotency_key: "cleanup-interrupted-publication" },
    testObservedAt,
  );
  await deleteStarted.promise;
  const inProgressCleanup = await administrationRequest(
    `/v1/ingestion-runs/${runId}/publication-cleanup`,
    { idempotency_key: "cleanup-interrupted-publication" },
  );
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
    `/v1/ingestion-runs/${requiredDocumentString(
      replacement.document,
      "id",
    )}/rejection`,
    {
      candidate_digest: requiredDocumentString(
        replacement.document,
        "candidate_digest",
      ),
      idempotency_key: "cleanup-interrupted-publication",
    },
  );
  expect(cleanupKeyCrossOperation.response.status).toBe(409);
  expect(cleanupKeyCrossOperation.document).toMatchObject({
    code: "idempotency_key_reused",
  });
  const competingCleanup = await administrationRequest(
    `/v1/ingestion-runs/${runId}/publication-cleanup`,
    { idempotency_key: "cleanup-competing-claim" },
  );
  expect(competingCleanup.response.status).toBe(409);
  expect(competingCleanup.document).toMatchObject({
    code: "publication_cleanup_in_progress",
  });

  testObservedAt = "2026-07-29T00:15:00.000Z";
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
      attempts: 3,
      failure_code: null,
    },
  });
  releaseDelete.resolve(undefined);
  await expect(staleCleanup).resolves.toEqual(cleanup.document);
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
        publication_manifest_digest = ?,
        publication_writer_token = ?
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
      `writer:${revisionId}`,
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
    claimed_at: testObservedAt,
  });
  const inProgressReplay = await approve(
    runId,
    digest,
    expectedRevision,
    approvalKey,
  );
  expect(inProgressReplay.response.status).toBe(202);
  expect(inProgressReplay.document).toEqual(inProgress.document);
  const changedInFlightReuse = await approve(
    runId,
    "0".repeat(64),
    expectedRevision,
    approvalKey,
  );
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
  expect(
    listed.objects.map((object) => object.key).sort(),
  ).toEqual(
    [...new Set(catalogueExport.objects.map((object) => object.key))].sort(),
  );
  for (const object of catalogueExport.objects) {
    expect((await testEnv.CATALOGUE_EXPORTS.get(object.key))?.size).toBe(
      object.byteLength,
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

test("a stalled late publication write reopens completed cleanup when exact compensation fails", async () => {
  const startedAt = "2026-07-29T02:00:00.000Z";
  const reconcileAt = "2026-07-29T02:05:00.000Z";
  const cleanupAt = "2026-07-29T02:10:00.000Z";
  testObservedAt = startedAt;
  const priorCurrentRevision = await testEnv.CATALOGUE_DB.prepare(
    `SELECT revision.id, revision.content_digest
    FROM catalogue_state AS state
    JOIN catalogue_revisions AS revision
      ON revision.id = state.current_revision_id
    WHERE state.singleton = 1`,
  ).first<{ id: string; content_digest: string }>();
  if (priorCurrentRevision !== null) {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_revisions
      SET content_digest = ?
      WHERE id = ?`,
    )
      .bind("0".repeat(64), priorCurrentRevision.id)
      .run();
  }
  const started = await startRun("start-stalled-late-writer");
  const runId = requiredDocumentString(started.document, "id");
  const candidateDigest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const expectedRevision = requiredDocumentString(
    started.document,
    "expected_current_revision_id",
  );
  const putStarted = deferred<string>();
  const releasePut = deferred<void>();
  let lateObjectKey: string | null = null;
  const stalledBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async put(
      key: string,
      value:
        | ReadableStream
        | ArrayBuffer
        | ArrayBufferView
        | string
        | null
        | Blob,
      options?: R2PutOptions,
    ) {
      lateObjectKey = key;
      putStarted.resolve(key);
      await releasePut.promise;
      return testEnv.CATALOGUE_EXPORTS.put(
        key,
        value,
        options,
      );
    },
    async delete() {
      throw new Error("synthetic late compensation failure");
    },
  });
  const approval = approveRunDirect(
    testEnv.CATALOGUE_DB,
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
  const identicalInFlight = await approve(
    runId,
    candidateDigest,
    expectedRevision,
    "approve-stalled-late-writer",
  );
  expect(identicalInFlight.response.status).toBe(202);
  expect(identicalInFlight.document).toMatchObject({
    contract: "card-keepr-administration-operation@1",
    operation: "approve_ingestion_run",
    status: "in_progress",
    idempotency_key: "approve-stalled-late-writer",
  });
  const crossOperationReuse = await administrationRequest(
    `/v1/ingestion-runs/${runId}/rejection`,
    {
      candidate_digest: candidateDigest,
      idempotency_key: "approve-stalled-late-writer",
    },
  );
  expect(crossOperationReuse.response.status).toBe(409);
  expect(crossOperationReuse.document).toMatchObject({
    code: "idempotency_key_reused",
  });
  testObservedAt = reconcileAt;
  const expiredClaimRecovery = await approve(
    runId,
    candidateDigest,
    expectedRevision,
    "approve-stalled-late-writer",
  );
  expect(expiredClaimRecovery.response.status).toBe(500);
  expect(expiredClaimRecovery.document).toMatchObject({
    code: "publication_abandoned",
  });

  const failed = await showRunDirect(
    testEnv.CATALOGUE_DB,
    testEnv.CATALOGUE_EXPORTS,
    runId,
    reconcileAt,
  );
  expect(failed).toMatchObject({
    state: "failed",
    publication_cleanup: { state: "pending", generation: 0 },
  });
  const completed = await retryPublicationCleanupDirect(
    testEnv.CATALOGUE_DB,
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
  expect(
    await testEnv.CATALOGUE_EXPORTS.get(lateObjectKey!),
  ).not.toBeNull();
  const reopened = await showRunDirect(
    testEnv.CATALOGUE_DB,
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
      testEnv.CATALOGUE_DB,
      testEnv.CATALOGUE_EXPORTS,
      runId,
      { idempotency_key: "cleanup-before-late-write" },
      cleanupAt,
    ),
  ).rejects.toThrow(
    "persisted administration success outcome does not match",
  );
  const recovered = await retryPublicationCleanupDirect(
    testEnv.CATALOGUE_DB,
    testEnv.CATALOGUE_EXPORTS,
    runId,
    { idempotency_key: "cleanup-after-late-write" },
    "2026-07-29T02:11:00.000Z",
  );
  expect(recovered).toMatchObject({
    publication_cleanup: { state: "completed" },
  });
  expect(
    await testEnv.CATALOGUE_EXPORTS.get(lateObjectKey!),
  ).toBeNull();
  if (priorCurrentRevision !== null) {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_revisions
      SET content_digest = ?
      WHERE id = ?`,
    )
      .bind(
        priorCurrentRevision.content_digest,
        priorCurrentRevision.id,
      )
      .run();
  }
});

test("a cleanup CAS loser replays the immutable completion that won the race", async () => {
  const startedAt = "2026-07-29T02:30:00.000Z";
  testObservedAt = startedAt;
  const priorCurrentRevision = await testEnv.CATALOGUE_DB.prepare(
    `SELECT revision.id, revision.content_digest
    FROM catalogue_state AS state
    JOIN catalogue_revisions AS revision
      ON revision.id = state.current_revision_id
    WHERE state.singleton = 1`,
  ).first<{ id: string; content_digest: string }>();
  if (priorCurrentRevision !== null) {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_revisions
      SET content_digest = ?
      WHERE id = ?`,
    )
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
      testEnv.CATALOGUE_DB,
      failingBucket,
      runId,
      {
        candidate_digest: requiredDocumentString(
          started.document,
          "candidate_digest",
        ),
        expected_current_revision_id: requiredDocumentString(
          started.document,
          "expected_current_revision_id",
        ),
        idempotency_key: "approve-cleanup-cas-replay",
      },
      startedAt,
    ),
  ).rejects.toMatchObject({
    code: "export_verification_failed",
  });
  const failed = await showRunDirect(
    testEnv.CATALOGUE_DB,
    testEnv.CATALOGUE_EXPORTS,
    runId,
    startedAt,
  );
  const pendingCleanup = requiredDocumentRecord(
    failed,
    "publication_cleanup",
  );
  const cleanupAt = requiredDocumentString(
    pendingCleanup,
    "not_before",
  );
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
        const administrationClaim =
          await testEnv.CATALOGUE_DB.prepare(
            `SELECT owner_token, claim_version
            FROM administration_idempotency_claims
            WHERE idempotency_key = ?`,
          )
            .bind(cleanupKey)
            .first<{
              owner_token: string;
              claim_version: number;
            }>();
        if (administrationClaim === null) {
          throw new Error("cleanup administration claim is missing");
        }
        await testEnv.CATALOGUE_DB.batch([
          testEnv.CATALOGUE_DB.prepare(
            `UPDATE ingestion_publication_cleanup
            SET state = 'completed',
                attempts = 1,
                failure_code = NULL,
                last_attempt_at = ?,
                completed_at = ?,
                idempotency_key = ?,
                request_json = ?,
                claim_token = NULL,
                claim_version = 2,
                claim_expires_at = NULL
            WHERE ingestion_run_id = ?`,
          ).bind(
            cleanupAt,
            cleanupAt,
            cleanupKey,
            requestJson,
            runId,
          ),
          testEnv.CATALOGUE_DB.prepare(
            `INSERT INTO administration_idempotency (
              idempotency_key,
              operation,
              request_json,
              response_json,
              http_status,
              outcome,
              created_at,
              claim_owner_token,
              claim_version
            ) VALUES (
              ?, 'retry_publication_cleanup', ?, ?, 200, 'success',
              ?, ?, ?
            )`,
          ).bind(
            cleanupKey,
            requestJson,
            JSON.stringify(completed),
            cleanupAt,
            administrationClaim.owner_token,
            administrationClaim.claim_version,
          ),
          testEnv.CATALOGUE_DB.prepare(
            `DELETE FROM administration_idempotency_claims
            WHERE idempotency_key = ?`,
          ).bind(cleanupKey),
        ]);
      }
      return testEnv.CATALOGUE_EXPORTS.list(options);
    },
  });
  const replayed = await retryPublicationCleanupDirect(
    testEnv.CATALOGUE_DB,
    racingBucket,
    runId,
    { idempotency_key: cleanupKey },
    cleanupAt,
  );
  expect(replayed).toEqual(completed);
  if (priorCurrentRevision !== null) {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_revisions
      SET content_digest = ?
      WHERE id = ?`,
    )
      .bind(
        priorCurrentRevision.content_digest,
        priorCurrentRevision.id,
      )
      .run();
  }
});

test("normal approval never adopts a prefix that becomes a registered export", async () => {
  const startedAt = "2026-07-29T02:40:00.000Z";
  testObservedAt = startedAt;
  const priorCurrentRevision = await testEnv.CATALOGUE_DB.prepare(
    `SELECT revision.id, revision.content_digest
     FROM catalogue_state AS state
     JOIN catalogue_revisions AS revision
       ON revision.id = state.current_revision_id
     WHERE state.singleton = 1`,
  ).first<{ id: string; content_digest: string }>();
  if (priorCurrentRevision !== null) {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_revisions SET content_digest = ? WHERE id = ?`,
    ).bind("0".repeat(64), priorCurrentRevision.id).run();
  }
  const started = await startRun("start-normal-prefix-registration-race");
  const runId = requiredDocumentString(started.document, "id");
  const candidateDigest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const expectedRevision = requiredDocumentString(
    started.document,
    "expected_current_revision_id",
  );
  const revisionId = await catalogueRevisionIdentity({
    runId,
    candidateDigest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const registeredManifestKey =
    `catalogue-exports/${revisionId}/registered-manifest.json`;
  const registeredBytes = new TextEncoder().encode("registered-export");
  await testEnv.CATALOGUE_EXPORTS.put(
    registeredManifestKey,
    registeredBytes,
  );
  let registered = false;
  const racingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async put() {
      if (!registered) {
        registered = true;
        const run = await testEnv.CATALOGUE_DB.prepare(
          `SELECT candidate_catalogue_digest
           FROM ingestion_runs WHERE id = ?`,
        )
          .bind(runId)
          .first<{ candidate_catalogue_digest: string }>();
        await testEnv.CATALOGUE_DB.batch([
          testEnv.CATALOGUE_DB.prepare(
            `INSERT INTO catalogue_revisions (
              id, ingestion_run_id, published_at, content_digest,
              expected_previous_revision_id, approved_candidate_digest
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            revisionId,
            runId,
            startedAt,
            run?.candidate_catalogue_digest ?? candidateDigest,
            expectedRevision,
            candidateDigest,
          ),
          testEnv.CATALOGUE_DB.prepare(
            `INSERT INTO catalogue_exports (
              catalogue_revision_id, manifest_key,
              manifest_digest, verified
            ) VALUES (?, ?, ?, 1)`,
          ).bind(
            revisionId,
            registeredManifestKey,
            "a".repeat(64),
          ),
        ]);
      }
      throw new Error("the deterministic publication prefix became registered");
    },
  });

  await expect(
    approveRunDirect(
      testEnv.CATALOGUE_DB,
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

  const stored = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       run.state,
       (SELECT COUNT(*) FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = run.id) AS cleanup_count,
       (SELECT current_revision_id FROM catalogue_state
        WHERE singleton = 1) AS current_revision_id
     FROM ingestion_runs AS run WHERE run.id = ?`,
  )
    .bind(runId)
    .first<{
      state: string;
      cleanup_count: number;
      current_revision_id: string;
    }>();
  expect(stored).toEqual({
    state: "failed",
    cleanup_count: 0,
    current_revision_id: expectedRevision,
  });
  expect(await showRunDirect(
    testEnv.CATALOGUE_DB,
    testEnv.CATALOGUE_EXPORTS,
    runId,
    startedAt,
  )).toMatchObject({
    state: "failed",
    failure_code: "publication_abandoned",
    publication_cleanup: null,
  });
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT catalogue_revision_id, manifest_key, manifest_digest, verified
     FROM catalogue_exports WHERE catalogue_revision_id = ?`,
  ).bind(revisionId).first()).toEqual({
    catalogue_revision_id: revisionId,
    manifest_key: registeredManifestKey,
    manifest_digest: "a".repeat(64),
    verified: 1,
  });
  expect(new Uint8Array(
    await (await testEnv.CATALOGUE_EXPORTS.get(
      registeredManifestKey,
    ))!.arrayBuffer(),
  )).toEqual(registeredBytes);
  expect((await testEnv.CATALOGUE_EXPORTS.list({
    prefix: `catalogue-exports/${revisionId}/`,
  })).objects.map((object) => object.key)).toEqual([
    registeredManifestKey,
  ]);
  if (priorCurrentRevision !== null) {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_revisions SET content_digest = ? WHERE id = ?`,
    ).bind(
      priorCurrentRevision.content_digest,
      priorCurrentRevision.id,
    ).run();
  }
});

test("cleanup deletes nothing when its failed prefix becomes registered", async () => {
  const startedAt = "2026-07-29T02:50:00.000Z";
  testObservedAt = startedAt;
  const priorCurrentRevision = await testEnv.CATALOGUE_DB.prepare(
    `SELECT revision.id, revision.content_digest
     FROM catalogue_state AS state
     JOIN catalogue_revisions AS revision
       ON revision.id = state.current_revision_id
     WHERE state.singleton = 1`,
  ).first<{ id: string; content_digest: string }>();
  if (priorCurrentRevision !== null) {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_revisions SET content_digest = ? WHERE id = ?`,
    ).bind("0".repeat(64), priorCurrentRevision.id).run();
  }
  const started = await startRun("start-cleanup-prefix-registration-race");
  const runId = requiredDocumentString(started.document, "id");
  const candidateDigest = requiredDocumentString(
    started.document,
    "candidate_digest",
  );
  const expectedRevision = requiredDocumentString(
    started.document,
    "expected_current_revision_id",
  );
  const revisionId = await catalogueRevisionIdentity({
    runId,
    candidateDigest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const failedObjectKey =
    `catalogue-exports/${revisionId}/partial-publication.bin`;
  const failedObjectBytes = new TextEncoder().encode("partial-publication");
  let failedAfterWrite = false;
  const failingBucket = proxyR2Bucket(testEnv.CATALOGUE_EXPORTS, {
    async put(...arguments_) {
      if (!failedAfterWrite) {
        failedAfterWrite = true;
        await testEnv.CATALOGUE_EXPORTS.put(
          failedObjectKey,
          failedObjectBytes,
        );
        throw new Error("synthetic publication write failure");
      }
      return testEnv.CATALOGUE_EXPORTS.put(...arguments_);
    },
  });
  await expect(
    approveRunDirect(
      testEnv.CATALOGUE_DB,
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
  const cleanup = await testEnv.CATALOGUE_DB.prepare(
    `SELECT not_before FROM ingestion_publication_cleanup
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first<{ not_before: string }>();
  const guard = await testEnv.CATALOGUE_DB.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'guard_catalogue_publication'`,
  ).first<{ sql: string }>();
  if (guard?.sql === undefined) {
    throw new Error("publication guard definition missing");
  }
  await testEnv.CATALOGUE_DB.prepare(
    "DROP TRIGGER guard_catalogue_publication",
  ).run();
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      runId,
      startedAt,
      candidateDigest,
      expectedRevision,
      candidateDigest,
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_exports (
        catalogue_revision_id, manifest_key, manifest_digest, verified
      ) VALUES (?, ?, ?, 1)`,
    ).bind(
      revisionId,
      failedObjectKey,
      "b".repeat(64),
    ),
  ]);
  await testEnv.CATALOGUE_DB.prepare(guard.sql).run();

  await expect(
    retryPublicationCleanupDirect(
      testEnv.CATALOGUE_DB,
      testEnv.CATALOGUE_EXPORTS,
      runId,
      { idempotency_key: "cleanup-prefix-registration-race" },
      cleanup?.not_before ?? "2026-07-29T03:00:00.000Z",
    ),
  ).rejects.toMatchObject({ code: "publication_cleanup_failed" });
  expect(new Uint8Array(
    await (await testEnv.CATALOGUE_EXPORTS.get(
      failedObjectKey,
    ))!.arrayBuffer(),
  )).toEqual(failedObjectBytes);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT catalogue_revision_id, manifest_key, manifest_digest, verified
     FROM catalogue_exports WHERE catalogue_revision_id = ?`,
  ).bind(revisionId).first()).toEqual({
    catalogue_revision_id: revisionId,
    manifest_key: failedObjectKey,
    manifest_digest: "b".repeat(64),
    verified: 1,
  });
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first()).toEqual({ current_revision_id: expectedRevision });
  if (priorCurrentRevision !== null) {
    await testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_revisions SET content_digest = ? WHERE id = ?`,
    ).bind(
      priorCurrentRevision.content_digest,
      priorCurrentRevision.id,
    ).run();
  }
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
    const body = object.body();
    await Promise.all([
      testEnv.CATALOGUE_EXPORTS.put(object.key, body.readable, {
        sha256: object.sha256,
      }),
      body.completed,
    ]);
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
        publication_manifest_digest = ?,
        publication_writer_token = ?
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
  await Promise.all(
    Array.from({ length: 1_001 }, (_, index) =>
      testEnv.CATALOGUE_EXPORTS.put(
        `catalogue-exports/${revisionId}/bulk-late-${String(index).padStart(4, "0")}.bin`,
        new Uint8Array([index % 256]),
      ),
    ),
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
  const repairableRevisions =
    status.document.repairable_catalogue_revision_ids;
  if (!Array.isArray(repairableRevisions)) {
    throw new Error("status retained revision chain is invalid");
  }
  expect(repairableRevisions[0]).toBe(revisionId);
  expect(repairableRevisions.length).toBeGreaterThanOrEqual(1);
  expect(repairableRevisions.length).toBeLessThanOrEqual(3);
  expect(repairableRevisions).not.toContain("catrev_spine_000");
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

test("Catalogue Export deletion plans bind an exact immutable set and delete an older export manifest last", async () => {
  const oldRevision = "catrev_delete_old";
  const currentRevision = "catrev_delete_current";
  const old = await seedDeletionExport(
    oldRevision,
    "run_delete_old",
    "2026-08-05T00:00:00.000Z",
  );
  const current = await seedDeletionExport(
    currentRevision,
    "run_delete_current",
    "2026-08-05T00:01:00.000Z",
  );
  await testEnv.CATALOGUE_EXPORTS.put(
    "catalogue-exports/catrev_unrelated/retained.bin",
    "retained",
  );
  await testEnv.EVIDENCE_OBJECTS.put(
    "source-snapshots/export-deletion-retained.json",
    "retained evidence",
  );
  await testEnv.BACKUPS.put(
    "d1-backups/export-deletion-retained.sql",
    "retained backup",
  );
  const unexpectedKey = `catalogue-exports/${oldRevision}/unexpected.bin`;
  await testEnv.CATALOGUE_EXPORTS.put(unexpectedKey, "not in manifest");

  testObservedAt = "2026-08-05T01:00:00.000Z";
  const unsafe = await administrationRequest(
    "/v1/catalogue-export-deletion-plans",
    {
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      plan_id: "export-delete-plan-unsafe",
    },
  );
  expect(unsafe.response.status).toBe(409);
  expect(unsafe.document).toMatchObject({ code: "unsafe_export_object_scope" });
  await testEnv.CATALOGUE_EXPORTS.delete(unexpectedKey);
  const prepared = await administrationRequest(
    "/v1/catalogue-export-deletion-plans",
    {
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      plan_id: "export-delete-plan-old",
    },
  );
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

  const currentPlan = await administrationRequest(
    "/v1/catalogue-export-deletion-plans",
    {
      catalogue_revision_id: currentRevision,
      manifest_digest: current.manifestDigest,
      expected_current_revision_id: currentRevision,
      plan_id: "export-delete-plan-current",
    },
  );
  expect(currentPlan.response.status).toBe(201);
  expect(currentPlan.document).toMatchObject({
    dependencies: expect.arrayContaining([
      expect.objectContaining({
        code: "current_catalogue_revision",
        severity: "blocking",
      }),
    ]),
  });
  const blockedCurrent = await administrationRequest(
    "/v1/catalogue-export-deletions",
    {
      plan_id: currentPlan.document.id,
      plan_digest: currentPlan.document.plan_digest,
      catalogue_revision_id: currentRevision,
      manifest_digest: current.manifestDigest,
      expected_current_revision_id: currentRevision,
      confirmation_revision_id: currentRevision,
      deletion_id: "export-deletion-current",
      idempotency_key: "export-deletion-current-key",
    },
  );
  expect(blockedCurrent.response.status).toBe(409);
  expect(blockedCurrent.document).toMatchObject({ code: "current_export_required" });

  testObservedAt = "2026-08-05T01:15:00.000Z";
  const expired = await administrationRequest(
    "/v1/catalogue-export-deletions",
    {
      plan_id: prepared.document.id,
      plan_digest: prepared.document.plan_digest,
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      confirmation_revision_id: oldRevision,
      deletion_id: "export-deletion-expired",
      idempotency_key: "export-deletion-expired-key",
    },
  );
  expect(expired.response.status).toBe(409);
  expect(expired.document).toMatchObject({ code: "deletion_plan_expired" });
  testObservedAt = "2026-08-05T01:01:00.000Z";

  const confirmed = await administrationRequest(
    "/v1/catalogue-export-deletions",
    {
      plan_id: prepared.document.id,
      plan_digest: prepared.document.plan_digest,
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      confirmation_revision_id: oldRevision,
      deletion_id: "export-deletion-old",
      idempotency_key: "export-deletion-old-key",
    },
  );
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
  await expect(
    testEnv.CATALOGUE_EXPORTS.list({ prefix: `catalogue-exports/${oldRevision}/` }),
  ).resolves.toMatchObject({ objects: [] });
  await expect(
    testEnv.CATALOGUE_EXPORTS.get(
      "catalogue-exports/catrev_unrelated/retained.bin",
    ),
  ).resolves.not.toBeNull();
  await expect(testEnv.EVIDENCE_OBJECTS.get(
    "source-snapshots/export-deletion-retained.json",
  )).resolves.not.toBeNull();
  await expect(testEnv.BACKUPS.get(
    "d1-backups/export-deletion-retained.sql",
  )).resolves.not.toBeNull();
  const replayed = await administrationRequest(
    "/v1/catalogue-export-deletions",
    {
      plan_id: prepared.document.id,
      plan_digest: prepared.document.plan_digest,
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      confirmation_revision_id: oldRevision,
      deletion_id: "export-deletion-old",
      idempotency_key: "export-deletion-old-key",
    },
  );
  expect(replayed.response.status).toBe(200);
  expect(replayed.document).toEqual(confirmed.document);
});

test("a partial Catalogue Export deletion stays unavailable and retries only its original object set", async () => {
  const oldRevision = "catrev_delete_partial";
  const currentRevision = "catrev_delete_partial_current";
  const old = await seedDeletionExport(
    oldRevision,
    "run_delete_partial",
    "2026-08-05T02:00:00.000Z",
  );
  await seedDeletionExport(
    currentRevision,
    "run_delete_partial_current",
    "2026-08-05T02:01:00.000Z",
  );
  testObservedAt = "2026-08-05T03:00:00.000Z";
  const prepared = await administrationRequest(
    "/v1/catalogue-export-deletion-plans",
    {
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      plan_id: "export-delete-plan-partial",
    },
  );
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

  const status = await administrationRequest(
    "/v1/catalogue-export-deletions/export-deletion-partial",
  );
  expect(status.document).toEqual(failed.document);
  const retried = await administrationRequest(
    "/v1/catalogue-export-deletions/export-deletion-partial/retry",
    {
      object_set_digest: prepared.document.object_set_digest,
      idempotency_key: "export-deletion-partial-retry-key",
    },
  );
  expect(retried.document).toMatchObject({
    state: "deleted",
    object_set_digest: prepared.document.object_set_digest,
    failure_code: null,
  });
  const retryReplay = await administrationRequest(
    "/v1/catalogue-export-deletions/export-deletion-partial/retry",
    {
      object_set_digest: prepared.document.object_set_digest,
      idempotency_key: "export-deletion-partial-retry-key",
    },
  );
  expect(retryReplay.document).toEqual(retried.document);
  const confirmationReplay = await administrationRequest(
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
  );
  expect(confirmationReplay.document).toEqual(failed.document);
});

test("an exact confirmation replay resumes an interrupted deleting operation", async () => {
  const oldRevision = "catrev_delete_interrupted";
  const currentRevision = "catrev_delete_interrupted_current";
  const old = await seedDeletionExport(
    oldRevision,
    "run_delete_interrupted",
    "2026-08-05T04:00:00.000Z",
  );
  await seedDeletionExport(
    currentRevision,
    "run_delete_interrupted_current",
    "2026-08-05T04:01:00.000Z",
  );
  testObservedAt = "2026-08-05T05:00:00.000Z";
  const prepared = await administrationRequest(
    "/v1/catalogue-export-deletion-plans",
    {
      catalogue_revision_id: oldRevision,
      manifest_digest: old.manifestDigest,
      expected_current_revision_id: currentRevision,
      plan_id: "export-delete-plan-interrupted",
    },
  );
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
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_export_deletions (
         id, plan_id, state, catalogue_revision_id, manifest_digest,
         expected_current_revision_id, object_set_digest, idempotency_key,
         request_json, requested_at, completed_at, failure_code
       ) VALUES (?, ?, 'deleting', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).bind(
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
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_exports
       SET maintenance_state = 'deleting', deletion_operation_id = ?
       WHERE catalogue_revision_id = ?`,
    ).bind(request.deletion_id, oldRevision),
  ]);

  const resumed = await administrationRequest(
    "/v1/catalogue-export-deletions",
    request,
  );
  expect(resumed.response.status).toBe(200);
  expect(resumed.document).toMatchObject({
    id: request.deletion_id,
    state: "deleted",
    object_set_digest: prepared.document.object_set_digest,
  });
  await expect(testEnv.CATALOGUE_EXPORTS.list({
    prefix: `catalogue-exports/${oldRevision}/`,
  })).resolves.toMatchObject({ objects: [] });
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
          selected_games: Array.isArray(body.selected_games)
            ? body.selected_games.map(String)
            : [],
          idempotency_key: String(body.idempotency_key),
        },
        testObservedAt ?? undefined,
      );
      return {
        response: Response.json(document, {
          status:
            document.contract ===
              "card-keepr-administration-operation@1" &&
            document.status === "in_progress"
              ? 202
              : 201,
        }),
        document,
      };
    } catch (error) {
      const status =
        error instanceof AdministrationProblem ? error.status : 500;
      const code =
        error instanceof AdministrationProblem
          ? error.code
          : "internal_error";
      const document = {
        type: `https://card-keepr.invalid/problems/${code}`,
        title: "Administration request rejected",
        status,
        code,
        detail:
          error instanceof AdministrationProblem
            ? error.message
            : "The administration request could not be completed.",
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
        ...(testObservedAt === null
          ? {}
          : { "x-keepr-test-now": testObservedAt }),
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
  const previousRevisionId = await testEnv.CATALOGUE_DB.prepare(
    "SELECT current_revision_id FROM catalogue_state WHERE singleton = 1",
  ).first<string>("current_revision_id");
  if (previousRevisionId === null) throw new Error("missing catalogue state");
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key
       ) VALUES (
         ?, 'publishing', '["one-piece"]', ?, ?, NULL, ?, ?, ?,
         '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, ?, NULL
       )`,
    ).bind(
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
    testEnv.CATALOGUE_DB.prepare(
      "UPDATE operation_state SET active_ingestion_run_id = ? WHERE singleton = 1",
    ).bind(runId),
  ]);
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_revisions (
       id, ingestion_run_id, published_at, content_digest,
       expected_previous_revision_id, approved_candidate_digest
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    revisionId,
    runId,
    publishedAt,
    digest,
    previousRevisionId,
    digest,
  ).run();
  const manifestKey = `catalogue-exports/${revisionId}/manifest.json`;
  const componentKey = `catalogue-exports/${revisionId}/components/${digest}.ndjson.gz`;
  const manifestWithPlaceholder = {
    export_schema_major: 4,
    catalogue_revision: { id: revisionId, content_sha256: digest },
    components: [{
      name: "cards",
      compressed_sha256: digest,
      compressed_bytes: revisionId.length,
    }],
    manifest_sha256: "0".repeat(64),
  };
  const manifestDigest = await sha256Text(
    `${canonicalJson(manifestWithPlaceholder)}\n`,
  );
  const manifest = {
    ...manifestWithPlaceholder,
    manifest_sha256: manifestDigest,
  };
  await testEnv.CATALOGUE_EXPORTS.put(componentKey, revisionId);
  await testEnv.CATALOGUE_EXPORTS.put(
    manifestKey,
    `${canonicalJson(manifest)}\n`,
  );
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_exports (
         catalogue_revision_id, manifest_key, manifest_digest, verified
       ) VALUES (?, ?, ?, 1)`,
    ).bind(revisionId, manifestKey, manifestDigest),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE catalogue_state SET current_revision_id = ?, published_at = ?
       WHERE singleton = 1`,
    ).bind(revisionId, publishedAt),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_runs SET state = 'published', published_revision_id = ?,
         resulting_revision_id = ?, publication_outcome = 'revision', terminal_at = ?
       WHERE id = ?`,
    ).bind(revisionId, revisionId, publishedAt, runId),
    testEnv.CATALOGUE_DB.prepare(
      "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE active_ingestion_run_id = ?",
    ).bind(runId),
  ]);
  return { manifestDigest, objectKeys: [componentKey, manifestKey] };
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
    get?: (
      ...arguments_: Parameters<R2Bucket["get"]>
    ) => ReturnType<R2Bucket["get"]>;
    put?: (
      ...arguments_: Parameters<R2Bucket["put"]>
    ) => ReturnType<R2Bucket["put"]>;
    delete?: (
      ...arguments_: Parameters<R2Bucket["delete"]>
    ) => ReturnType<R2Bucket["delete"]>;
    list?: (
      ...arguments_: Parameters<R2Bucket["list"]>
    ) => ReturnType<R2Bucket["list"]>;
  },
): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      const override =
        property === "get"
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
