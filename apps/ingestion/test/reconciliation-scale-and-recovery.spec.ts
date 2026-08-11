import { expect, test } from "vitest";
import {
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/product-release-source-adapters";
import {
  type CatalogueBackupWorkflowParams,
} from "../../../src/catalogue/backup-workflow";
import { currentCatalogueStatus } from "../../../src/catalogue/read";
import {
  installReconciliationSuite,
  testEnv,
  approve,
  collect,
  collectRequests,
  expectRetainedEvidenceInvalid,
  post,
  reconcile,
  requiredFirst,
  requiredString,
} from "./reconciliation-helpers";
import ingestionWorker from "../src/index";

installReconciliationSuite();

test("every planned request contributes exactly one provenance-bound observation set in deterministic request order", async () => {
  const run = await collectRequests(
    [
      { id: "partition-a", scenario: "base" },
      { id: "partition-b", scenario: "new-locator" },
    ],
    "multi-request-complete-coverage",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.publishable).toBe(true);
  expect(requiredFirst(reconciled.document, "cards")).toMatchObject({
    name: "Monkey.D.Luffy",
  });
  expect(requiredFirst(reconciled.document, "printings")).toMatchObject({
    rarity: { normalized: "leader" },
  });
  const plans = await testEnv.CATALOGUE_DB.prepare(
    `SELECT request.request_id, candidate.source_snapshot_id,
            candidate.source_observation_set_id
     FROM reconciliation_candidates AS candidate
     JOIN source_snapshots AS snapshot
       ON snapshot.id = candidate.source_snapshot_id
     JOIN source_requests AS request
       ON request.ingestion_run_id = snapshot.ingestion_run_id
      AND request.source_snapshot_id = snapshot.id
     WHERE candidate.ingestion_run_id = ?
     ORDER BY request.sequence_number`,
  )
    .bind(run.id)
    .all<{
      request_id: string;
      source_snapshot_id: string;
      source_observation_set_id: string;
    }>();
  expect(plans.results.map((row) => row.request_id)).toEqual([
    "partition-a",
    "partition-b",
  ]);
  expect(new Set(plans.results.map((row) => row.source_snapshot_id)).size).toBe(
    2,
  );
  expect(
    new Set(plans.results.map((row) => row.source_observation_set_id)).size,
  ).toBe(2);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
    idempotency_key: "reject-multi-request-complete-coverage",
  });
});

test("aggregate reconciliation size is rejected before any retained object is read", async () => {
  const run = await collectRequests(
    [
      { id: "aggregate-a", scenario: "base" },
      { id: "aggregate-b", scenario: "new-locator" },
      { id: "aggregate-c", scenario: "base" },
    ],
    "aggregate-budget-before-object-read",
  );
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT observations.content_object_key
     FROM source_observation_sets AS observations
     JOIN source_snapshots AS snapshots
       ON snapshots.id = observations.source_snapshot_id
     WHERE snapshots.ingestion_run_id = ?
     ORDER BY snapshots.request_id`,
  ).bind(run.id).all<{ content_object_key: string }>();
  expect(retained.results).toHaveLength(3);
  await testEnv.CATALOGUE_DB.prepare(
    `DROP TRIGGER source_observation_sets_are_immutable_on_update`,
  ).run();
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE source_observation_sets
     SET content_byte_length = 12582912
     WHERE source_snapshot_id IN (
       SELECT id FROM source_snapshots WHERE ingestion_run_id = ?
     )`,
  ).bind(run.id).run();
  await testEnv.CATALOGUE_DB.prepare(
    `CREATE TRIGGER source_observation_sets_are_immutable_on_update
     BEFORE UPDATE ON source_observation_sets
     BEGIN
       SELECT RAISE(ABORT, 'immutable_source_observation_set');
     END`,
  ).run();
  await testEnv.EVIDENCE_OBJECTS.delete(
    retained.results[0]!.content_object_key,
  );

  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [expect.objectContaining({
      code: "retained_evidence_invalid",
      detail: expect.stringContaining(
        "aggregate reconciliation byte budget",
      ),
    })],
  });
  expect(JSON.stringify(blocked.document)).not.toContain(
    "bytes are unavailable",
  );
});

test("empty first, middle, and last partitions remain durable and digest-bound", async () => {
  for (const emptyIndex of [0, 1, 2]) {
    const requests = ["base", "new-locator", "base"].map(
      (scenario, index) => ({
        id: `partition-${index}`,
        scenario:
          index === emptyIndex ? "complete-empty-lineage" : scenario,
      }),
    );
    const run = await collectRequests(
      requests,
      `durable-empty-partition-${emptyIndex}`,
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const partitions = await testEnv.CATALOGUE_DB.prepare(
      `SELECT sequence_number, request_id, source_snapshot_id,
              source_observation_set_id
       FROM reconciliation_evidence_partitions
       WHERE ingestion_run_id = ?
       ORDER BY sequence_number`,
    )
      .bind(run.id)
      .all<{
        sequence_number: number;
        request_id: string;
        source_snapshot_id: string;
        source_observation_set_id: string;
      }>();
    expect(partitions.results.map(({ request_id }) => request_id)).toEqual(
      requests.map(({ id }) => id),
    );
    expect(
      partitions.results.every(
        (row) =>
          row.source_snapshot_id.startsWith("srcsnap_") &&
          row.source_observation_set_id.startsWith("srcobsset_"),
      ),
    ).toBe(true);
    const digest = await testEnv.CATALOGUE_DB.prepare(
      `SELECT group_concat(content, '') AS value
       FROM (
         SELECT content
         FROM reconciliation_payload_chunks
         WHERE ingestion_run_id = ? AND payload_kind = 'digest'
         ORDER BY chunk_index
       )`,
    )
      .bind(run.id)
      .first<{ value: string }>();
    expect(digest?.value).toContain('"evidence_partitions"');
    for (const request of requests) {
      expect(digest?.value).toContain(`"requestId":"${request.id}"`);
    }
    await post(`/v1/ingestion-runs/${run.id}/rejection`, {
      candidate_digest: requiredString(
        reconciled.document,
        "candidate_digest",
      ),
      idempotency_key: `reject-durable-empty-${emptyIndex}`,
    });
  }
}, 30_000);

test("unplanned requests fail at D1 while duplicate and unplanned observation sets fail reconciliation", async () => {
  const missing = await collectRequests(
    [{ id: "partition-a", scenario: "base" }],
    "multi-request-missing-coverage",
  );
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'partition-missing', 1, 'GET',
         'https://official-source.invalid/reconciliation/new-locator',
         '{}', 'missing', 'pending')`,
    )
      .bind(missing.id)
      .run(),
  ).rejects.toThrow(/source_request_not_in_immutable_plan/);
  const exact = await reconcile(missing.id);
  expect(exact.response.status).toBe(200);
  await post(`/v1/ingestion-runs/${missing.id}/rejection`, {
    candidate_digest: requiredString(exact.document, "candidate_digest"),
    idempotency_key: "reject-exact-plan-after-unplanned-insert",
  });

  const duplicate = await collectRequests(
    [{ id: "partition-a", scenario: "base" }],
    "multi-request-duplicate-set",
  );
  const duplicateSuffix = crypto.randomUUID();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_parse_operations (
       id, source_snapshot_id, adapter_version, intent, idempotency_key,
       observation_set_id, content_object_key, parsed_at, state,
       content_digest, content_byte_length, observation_count
     )
     SELECT ?, source_snapshot_id, adapter_version, 'collection', ?,
            ?, ?, parsed_at, 'finalized',
            content_digest, content_byte_length, observation_count
     FROM source_parse_operations
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     ) AND intent = 'collection'`,
  )
    .bind(
      `parse_${duplicateSuffix}`,
      `duplicate-${duplicateSuffix}`,
      `srcobsset_${duplicateSuffix}`,
      `source-observations/duplicate-${duplicateSuffix}.json`,
      duplicate.id,
    )
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_observation_sets (
       id, parse_operation_id, source_snapshot_id, source_lineage,
       supported_game, game_profile_version, adapter_version, parsed_at,
       content_digest, content_byte_length, content_object_key,
       observation_count
     )
     SELECT ?, ?, source_snapshot_id, source_lineage, supported_game,
            game_profile_version, adapter_version, parsed_at,
            content_digest, content_byte_length, ?, observation_count
     FROM source_observation_sets
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     ) ORDER BY id LIMIT 1`,
  )
    .bind(
      `srcobsset_${duplicateSuffix}`,
      `parse_${duplicateSuffix}`,
      `source-observations/duplicate-${duplicateSuffix}.json`,
      duplicate.id,
    )
    .run();
  await expectRetainedEvidenceInvalid(
    duplicate.id,
    "requires exactly one collection Source Observation Set",
  );

  const unplanned = await collectRequests(
    [{ id: "partition-a", scenario: "base" }],
    "multi-request-unplanned-set",
  );
  const rogue = crypto.randomUUID();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_fetch_attempts (
       id, ingestion_run_id, request_id, attempt_number, requested_at,
       completed_at, outcome, http_status, response_headers_json,
       retry_after_ms, diagnostic
     )
     SELECT ?, ingestion_run_id, request_id, 99, requested_at,
            completed_at, outcome, http_status, response_headers_json,
            retry_after_ms, diagnostic
     FROM source_fetch_attempts
     WHERE ingestion_run_id = ? ORDER BY attempt_number LIMIT 1`,
  )
    .bind(`fetch_${rogue}`, unplanned.id)
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_snapshots (
       id, ingestion_run_id, request_id, fetch_attempt_id, request_method,
       request_url, request_headers_json, representation_fingerprint,
       response_vary_json, retrieved_at, http_status, response_headers_json,
       media_type, content_digest, content_byte_length, content_object_key,
       source_lineage, supported_game, game_profile_version, adapter_version,
       reused_source_snapshot_id
     )
     SELECT ?, ingestion_run_id, request_id, ?, request_method,
            request_url, request_headers_json, representation_fingerprint,
            response_vary_json, retrieved_at, http_status,
            response_headers_json, media_type, content_digest,
            content_byte_length, content_object_key, source_lineage,
            supported_game, game_profile_version, adapter_version, NULL
     FROM source_snapshots
     WHERE id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     )`,
  )
    .bind(`snapshot_${rogue}`, `fetch_${rogue}`, unplanned.id)
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_parse_operations (
       id, source_snapshot_id, adapter_version, intent, idempotency_key,
       observation_set_id, content_object_key, parsed_at, state,
       content_digest, content_byte_length, observation_count
     )
     SELECT ?, ?, adapter_version, 'collection', ?, ?, ?, parsed_at,
            'finalized', content_digest, content_byte_length,
            observation_count
     FROM source_parse_operations
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     ) AND intent = 'collection'`,
  )
    .bind(
      `parse_${rogue}`,
      `snapshot_${rogue}`,
      `rogue-${rogue}`,
      `srcobsset_${rogue}`,
      `source-observations/rogue-${rogue}.json`,
      unplanned.id,
    )
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_observation_sets (
       id, parse_operation_id, source_snapshot_id, source_lineage,
       supported_game, game_profile_version, adapter_version, parsed_at,
       content_digest, content_byte_length, content_object_key,
       observation_count
     )
     SELECT ?, ?, ?, source_lineage, supported_game, game_profile_version,
            adapter_version, parsed_at, content_digest, content_byte_length,
            ?, observation_count
     FROM source_observation_sets
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     ) ORDER BY id LIMIT 1`,
  )
    .bind(
      `srcobsset_${rogue}`,
      `parse_${rogue}`,
      `snapshot_${rogue}`,
      `source-observations/rogue-${rogue}.json`,
      unplanned.id,
    )
    .run();
  await expectRetainedEvidenceInvalid(
    unplanned.id,
    "Unplanned Source Observation Set",
  );
});

test("recovery health gates fixture evidence injection and reconciliation before mutation", async () => {
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blockedStart = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "blocked-recovery-start",
    requests: officialSourceDiscoveryRequests("one-piece-en"),
  });
  expect(blockedStart.response.status).toBe(409);
  expect(blockedStart.document).toMatchObject({
    code: "recovery_not_verified",
  });
  const blockedMutation = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ingestion_runs
        WHERE idempotency_key = 'blocked-recovery-start') AS runs,
       active_ingestion_run_id
     FROM operation_state
     WHERE singleton = 1`,
  ).first<{ runs: number; active_ingestion_run_id: string | null }>();
  expect(blockedMutation).toEqual({
    runs: 0,
    active_ingestion_run_id: null,
  });
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  const run = await collect(
    "/reconciliation/base",
    "blocked-recovery-reconciliation",
  );
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blockedReconciliation = await reconcile(run.id);
  expect(blockedReconciliation.response.status).toBe(409);
  expect(blockedReconciliation.document).toMatchObject({
    code: "recovery_not_verified",
  });
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  const resumed = await reconcile(run.id, {}, 45_000);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(resumed.document, "candidate_digest"),
    idempotency_key: "reject-after-recovery-restored",
  });
}, 60_000);

test("degraded recovery permits evidence collection starts and retries while blocked recovery does not", async () => {
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'degraded' WHERE singleton = 1",
  ).run();
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "degraded-recovery-start",
    requests: officialSourceDiscoveryRequests("one-piece-en"),
  });
  expect(started.response.status).toBe(201);
  expect(started.document).toMatchObject({ state: "collecting" });

  const sourceRunId = requiredString(started.document, "id");
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_runs
       SET state = 'failed', terminal_at = started_at,
           failure_code = 'synthetic_retry_source',
           progress_json = json_set(progress_json, '$.current_stage', 'failed')
       WHERE id = ?`,
    ).bind(sourceRunId),
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = NULL, recovery_health = 'degraded'
       WHERE singleton = 1`,
    ),
  ]);
  const retried = await post(
    `/v1/ingestion-runs/${sourceRunId}/collection/retry`,
    { idempotency_key: "degraded-recovery-retry" },
  );
  expect(retried.response.status).toBe(201);
  expect(retried.document).toMatchObject({
    state: "collecting",
    linked_run_id: sourceRunId,
  });
});

test("a partial Gundam refresh accepts one selected production lineage independently", async () => {
  const sourceLineage = "gundam-en-asia";
  const adapterVersion = "gundam-en-asia@7";
  const oneLocale = await post("/v1/ingestion-runs/evidence", {
    plans: [{
      supported_game: "gundam",
      source_lineage: sourceLineage,
      adapter_version: adapterVersion,
      requests: officialSourceDiscoveryRequests(sourceLineage),
    }],
    idempotency_key: `gundam-one-lineage-${crypto.randomUUID()}`,
  });
  expect(oneLocale.response.status).toBe(201);
  expect(oneLocale.document).toMatchObject({
    selected_games: ["gundam"],
    evidence_plans: [{
      supported_game: "gundam",
      source_lineage: sourceLineage,
      adapter_version: adapterVersion,
    }],
  });
  // Admission is the public behavior under test. Release the test database's
  // singleton lock without depending on a live publisher response so the next
  // independent administration scenario can begin.
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
});

test("publication stays readable while its immutable degraded backup blocks the next approval", async () => {
  const firstRun = await collect(
    "/reconciliation/base",
    "publication-backup-degraded-first",
  );
  const firstCandidate = await reconcile(firstRun.id);
  const failingWorkflow = {
    async create() {
      throw new Error("synthetic backup dispatch outage");
    },
    async get() {
      throw new Error("synthetic backup dispatch outage");
    },
  } as unknown as Workflow<CatalogueBackupWorkflowParams>;
  const publicEnv = {
    ...testEnv,
    CATALOGUE_BACKUP_WORKFLOW: failingWorkflow,
  } as unknown as Env;
  const approvalResponse = await ingestionWorker.fetch(
    new Request(
      `https://card-keepr.invalid/v1/ingestion-runs/${firstRun.id}/approval`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer vitest-administration-key",
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.240",
        },
        body: JSON.stringify({
          candidate_digest: requiredString(
            firstCandidate.document,
            "candidate_digest",
          ),
          expected_current_revision_id: requiredString(
            firstCandidate.document,
            "expected_current_revision_id",
          ),
          idempotency_key: "publication-backup-degraded-approval",
        }),
      },
    ),
    publicEnv,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  expect(approvalResponse.status).toBe(200);
  const published = await approvalResponse.json<Record<string, unknown>>();
  const revisionId = requiredString(published, "resulting_revision_id");
  const statusResponse = await ingestionWorker.fetch(
    new Request("https://card-keepr.invalid/v1/status", {
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": "203.0.113.241",
      },
    }),
    publicEnv,
  );
  expect(await statusResponse.json()).toMatchObject({
    safe_state: {
      current_revision_id: revisionId,
      recovery_health: "degraded",
    },
  });
  await expect(currentCatalogueStatus(testEnv.CATALOGUE_DB)).resolves
    .toMatchObject({
      revisionId,
    });

  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  const secondRun = await collect(
    "/reconciliation/profile-one-piece",
    "publication-backup-degraded-second",
  );
  const secondCandidate = await reconcile(secondRun.id);
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'degraded' WHERE singleton = 1",
  ).run();
  const blocked = await approve(secondCandidate.document);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({ code: "recovery_not_verified" });
}, 60_000);
