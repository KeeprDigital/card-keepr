import { syntheticAdapterRegistrations } from "../../../test/support/source-adapters";
import { catalogueStore } from "../../../src/catalogue/shared";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import * as ingestionQueries from "./query-helpers/ingestion";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  captureOperationIdentity,
  startEvidenceRun,
  parseCapturedRequest,
  pendingEvidenceRequests,
  persistOfficialSourceCollectionPlan,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import {
  globalEmergencySourceRequestCeiling,
  installedSourceAdapterRegistrations,
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/adapters";
import { sha256, utf8 } from "../../../src/catalogue/shared";
import retainedFusionWorldDiscovery from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-restructured-card-search.json";
import {
  administrationRequest,
  clearActiveRunForNextScenario,
  type CollectionDocument,
  createCollection,
  exactOnePiecePlan,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  resumeCollection,
  showCollection,
  waitForEvidenceCondition,
  waitForEvidenceDiagnostic,
  waitForEvidenceRun,
} from "./runtime-helpers";

installRuntimeSuite();

test("successful captures remain auditable when a later required response is rejected or exhausts its retries", async () => {
  // A redirect stays a terminal source-contract failure; exhausted
  // retryable HTTP responses now pause the run non-terminally instead.
  // Both outcomes retain the sibling capture's Source Snapshot and
  // Source Observation Set for audit.
  for (const scenario of [
    {
      key: "retained_after_rejected_001",
      problemUrl: "https://retained-redirect-official-source.invalid/redirect",
      expected: {
        state: "failed",
        failure_code: "source_redirect_rejected",
      },
    },
    {
      key: "retained_after_transport_pause_001",
      problemUrl: "https://retained-failure-official-source.invalid/unavailable",
      expected: {
        state: "paused",
        failure_code: null,
        pause: { reason: "source_transport_retries_exhausted" },
      },
    },
  ]) {
    const response = await fixtureEvidenceRequest({
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: scenario.key,
      requests: [
        {
          id: "captured",
          url: `https://${new URL(scenario.problemUrl).hostname}/cards`,
        },
        { id: "terminal", url: scenario.problemUrl },
      ],
    });
    expect(response.status).toBe(201);
    const run = await response.json<CollectionDocument>();
    const accepted = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
    expect(accepted.status).toBe(202);
    await accepted.body?.cancel();
    const settled = await waitForEvidenceCondition(
      run.id,
      (current) => current.state === scenario.expected.state,
      12_000,
    );
    expect(settled).toMatchObject(scenario.expected);
    expect(settled.snapshots).toHaveLength(1);
    expect(settled.observation_sets).toHaveLength(1);

    const retained = await showCollection(run.id);
    expect(retained.snapshots).toEqual(settled.snapshots);
    expect(retained.observation_sets).toEqual(settled.observation_sets);
    await clearActiveRunForNextScenario();
  }
}, 24_000);

test("a successful response remains snapshotted when parsing terminally fails", async () => {
  const run = await createCollection(
    "source_collection_parse_failure_001",
    "https://parse-failure-official-source.invalid/invalid-json",
  );
  const accepted = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const failed = await waitForEvidenceRun(run.id, "failed", 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  expect(failed.snapshots).toHaveLength(1);
  expect(failed.observation_sets).toEqual([]);
  expect(failed.diagnostics).toHaveLength(1);
  expect(failed.diagnostics[0]).toMatchObject({
    outcome: "success",
    http_status: 200,
  });

  const retained = await showCollection(run.id);
  expect(retained.snapshots).toEqual(failed.snapshots);
});

test("validator revalidation creates fresh fetch evidence and reuses bytes only for the same adapter version", async () => {
  const firstRun = await createCollection(
    "source_collection_cache_first_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@3",
    { "accept-language": "en" },
  );
  const first = await resumeCollection(firstRun.id);
  const firstSnapshot = first.snapshots[0];
  if (firstSnapshot === undefined) throw new Error("missing first snapshot");
  await clearActiveRunForNextScenario();

  const differentRepresentationRun = await createCollection(
    "source_collection_cache_language_changed_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@3",
    { "accept-language": "fr" },
  );
  const differentRepresentation = await resumeCollection(differentRepresentationRun.id);
  expect(differentRepresentation.snapshots[0]).toMatchObject({
    http: { status: 200 },
    reused_source_snapshot_id: null,
  });
  await clearActiveRunForNextScenario();

  const revalidatedRun = await createCollection(
    "source_collection_cache_second_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@3",
    { "accept-language": "en" },
  );
  const revalidated = await resumeCollection(revalidatedRun.id);
  const revalidatedSnapshot = revalidated.snapshots[0];
  if (revalidatedSnapshot === undefined) {
    throw new Error("missing revalidated snapshot");
  }
  await clearActiveRunForNextScenario();
  expect(revalidatedSnapshot).toMatchObject({
    http: { status: 304 },
    reused_source_snapshot_id: firstSnapshot.id,
    content: {
      digest: firstSnapshot.content.digest,
      object_key: firstSnapshot.content.object_key,
    },
  });
  expect(revalidated.diagnostics[0]).toMatchObject({
    outcome: "cache_revalidated",
    http_status: 304,
  });

  const changedAdapterRun = await createCollection(
    "source_collection_cache_adapter_changed_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json-capped@1",
    { "accept-language": "en" },
  );
  const changedAdapter = await resumeCollection(changedAdapterRun.id);
  const changedAdapterSnapshot = changedAdapter.snapshots[0];
  if (changedAdapterSnapshot === undefined) {
    throw new Error("missing changed-adapter snapshot");
  }
  expect(changedAdapterSnapshot.http.status).toBe(200);
  expect(changedAdapterSnapshot.reused_source_snapshot_id).toBeNull();
}, 12_000);

test("Retry-After is audited without shortening the Official Source deadline", async () => {
  const run = await createCollection(
    "source_retry_after_long_001",
    "https://retry-after-official-source.invalid/retry-after-long",
  );
  const accepted = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const waiting = await waitForEvidenceDiagnostic(run.id);
  expect(waiting).toMatchObject({
    state: "collecting",
    diagnostics: [
      {
        attempt_number: 1,
        outcome: "http_failure",
        http_status: 503,
        retry_after_ms: 120_000,
      },
    ],
  });
  const childWorkflowId = waiting.workflow.child_ids[0];
  if (childWorkflowId === undefined) {
    throw new Error("missing hostname Workflow identity");
  }
  const childWorkflow = await env.EVIDENCE_HOST_WORKFLOW.get(childWorkflowId);
  await childWorkflow.terminate();
});

test("adapter registrations stay constrained while mismatched production identities fail closed", async () => {
  const mismatched = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "one-piece",
    source_lineage: "unrelated-source",
    adapter_version: "one-piece-en@6",
    idempotency_key: "source_adapter_mismatch_001",
    requests: [
      {
        id: "cards",
        url: "https://official-source.invalid/cards",
      },
    ],
  });
  expect(mismatched.status).toBe(422);
  await expect(mismatched.json()).resolves.toMatchObject({
    code: "adapter_binding_mismatch",
  });

  const constrained = await sourceEvidenceQueries
    .readSourceAdapterVersionsAdapterVersionSourceLineage(env.CATALOGUE_DB)
    .all<{
      adapter_version: string;
      source_lineage: string;
      supported_game: string;
      game_profile_version: string;
      parser_contract: string;
      adapter_origin: string;
      request_capacity: number;
    }>();
  expect(constrained.results).toEqual(
    [...installedSourceAdapterRegistrations, ...syntheticAdapterRegistrations]
      .map((adapter) => ({
        adapter_version: adapter.adapterVersion,
        source_lineage: adapter.sourceLineage,
        supported_game: adapter.supportedGame,
        game_profile_version: adapter.gameProfileVersion,
        parser_contract: adapter.parserContract,
        adapter_origin: adapter.origin,
        request_capacity: adapter.requestCapacity,
      }))
      .sort((left, right) => left.adapter_version.localeCompare(right.adapter_version)),
  );
  for (const adapter of installedSourceAdapterRegistrations) {
    expect(adapter.requestCapacity).toBeGreaterThanOrEqual(1);
    expect(adapter.requestCapacity).toBeLessThanOrEqual(globalEmergencySourceRequestCeiling);
    expect(Number.isSafeInteger(adapter.requestCapacity)).toBe(true);
  }
});

test("a production plan cannot replace its discovery root with a raw surface", async () => {
  const plan = exactOnePiecePlan("source_exact_plan_omission_001");
  plan.requests[0]!.id = "one-piece-en:card-list";
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", plan);
  expect(response.status).toBe(422);
  await expect(response.json()).resolves.toMatchObject({
    code: "incomplete_source_plan",
  });
});

test.each([["cap"], ["pagination"]])(
  "raw discovery %s evidence fails closed after retaining the snapshot",
  async (failure) => {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const plan = exactOnePiecePlan(`source_exact_${failure}_${String(repetition).padStart(3, "0")}`);
      plan.requests[0]!.headers = {
        ...plan.requests[0]!.headers,
        "user-agent": `card-keepr-runtime-parser/${failure}-${repetition}`,
      };
      const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", plan);
      expect(created.status).toBe(201);
      const run = await created.json<{ id: string }>();
      const terminal = await resumeCollection(run.id, 20_000);
      if (terminal.failure_code !== "source_parse_failed") {
        const failures = await sourceEvidenceQueries
          .readSourceRequestsRequestIdStateForRuntimeCaptureFailures(env.CATALOGUE_DB)
          .bind(run.id)
          .all();
        throw new Error(
          JSON.stringify({
            failure_code: terminal.failure_code,
            source_failures: failures.results,
          }),
        );
      }
      expect(terminal).toMatchObject({
        state: "failed",
        failure_code: "source_parse_failed",
      });
      // Four discovery captures and four accepted card-content surfaces.
      expect(terminal.snapshots).toHaveLength(8);
      expect(terminal.observation_sets).toHaveLength(7);
      expect(terminal.snapshots.some((snapshot) => snapshot.request.url === plan.requests[0]!.url)).toBe(true);
      await expect(
        sourceEvidenceQueries
          .readSourceRequestsRequestIdFailureCodeForRuntimeCaptureFailures(env.CATALOGUE_DB)
          .bind(run.id)
          .all(),
      ).resolves.toMatchObject({
        results: [
          {
            request_id: "one-piece-en:card-list",
            failure_code: "source_parse_failed",
          },
        ],
      });
    }
  },
  90_000,
);

test.each([
  ["declared", "large-json"],
  ["chunked", "oversized-chunked-json"],
])(
  "%s oversized response bodies fail before an immutable snapshot is retained",
  async (shape, path) => {
    const run = await createCollection(
      `source_${shape}_capture_bound_001`,
      `https://large-official-source.invalid/${path}`,
      "fixture-one-piece-json-capped@1",
    );
    const failed = await resumeCollection(run.id, 15_000);
    expect(failed).toMatchObject({
      state: "failed",
      failure_code: "source_request_retries_exhausted",
      snapshots: [],
      observation_sets: [],
    });
    expect(failed.diagnostics.map(({ outcome }) => outcome)).toEqual([
      "body_failure",
      "body_failure",
      "body_failure",
      "body_failure",
    ]);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const identity = await captureOperationIdentity(run.id, "one-piece-en:discovery", attempt);
      expect(await env.EVIDENCE_OBJECTS.head(identity.objectKey)).toBeNull();
    }
  },
  30_000,
);

test("body streaming failures are durable diagnostics with bounded retries", async () => {
  const run = await createCollection(
    "source_body_failure_001",
    "https://body-failure-official-source.invalid/body-failure",
  );
  const accepted = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const failed = await waitForEvidenceRun(run.id, "failed", 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(failed.diagnostics).toHaveLength(4);
  expect(
    failed.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
    })),
  ).toEqual([
    { attempt_number: 1, outcome: "body_failure" },
    { attempt_number: 2, outcome: "body_failure" },
    { attempt_number: 3, outcome: "body_failure" },
    { attempt_number: 4, outcome: "body_failure" },
  ]);
}, 15_000);

// Retain one captured Official Source response so the capture path can parse
// it without a live publisher fetch.
async function retainProductionSnapshot(
  runId: string,
  requestId: string,
  url: string,
  bytes: Uint8Array,
): Promise<string> {
  const digest = await sha256(bytes);
  const snapshotId = `srcsnap_${digest}`;
  const fetchId = `srcfetch_${digest}`;
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  await env.EVIDENCE_OBJECTS.put(objectKey, bytes);
  await catalogueStore(env.CATALOGUE_DB).batch([
    sourceEvidenceQueries
      .insertSourceFetchAttemptsForRetainCapturedDiscoveryRoot(env.CATALOGUE_DB)
      .bind(fetchId, runId, requestId),
    sourceEvidenceQueries
      .insertSourceSnapshotsForRetainCapturedDiscoveryRoot(env.CATALOGUE_DB)
      .bind(
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
  ]);
  return snapshotId;
}

test("production discovery that proves no collection surface fails its last discovery stage closed", async () => {
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "official_collection_plan_empty_001",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(created.status).toBe(201);
  const run = await created.json<{ id: string }>();
  const storedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (root === undefined) throw new Error("discovery root request is absent");

  // The retained discovery root proves its publisher navigation, so it plans
  // its stage requests and cannot yet freeze a Collection Plan.
  await parseCapturedRequest(
    catalogueStore(env.CATALOGUE_DB),
    env.EVIDENCE_OBJECTS,
    storedRun,
    root,
    await retainProductionSnapshot(
      run.id,
      root.request_id,
      root.url,
      Buffer.from(retainedFusionWorldDiscovery.body_base64, "base64"),
    ),
  );

  const staged = await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id);
  const cards = staged.find(({ request_id }) => request_id.startsWith("fusion-world-en:listing:cards:"));
  if (cards === undefined) throw new Error("cards discovery stage is absent");
  // Every other discovery stage completes without proving a collection
  // surface, leaving the cards stage as the run's last outstanding request.
  await sourceEvidenceQueries
    .setSourceRequestsStateForProductionDiscoveryThatProvesNoCollectionSurfaceFailsLast(env.CATALOGUE_DB)
    .bind(run.id, cards.request_id)
    .run();

  const stageSnapshotId = await retainProductionSnapshot(
    run.id,
    cards.request_id,
    cards.url,
    utf8("<html><title>BANDAI DRAGON BALL CARD LIST</title><main>Cards</main></html>"),
  );
  await expect(
    parseCapturedRequest(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, storedRun, cards, stageSnapshotId),
  ).resolves.toMatchObject({
    kind: "done",
    failure_code: "official_collection_plan_empty",
  });
  await expect(
    sourceEvidenceQueries
      .readSourceRequestsRequestIdStateForProductionDiscoveryThatProvesNoCollectionSurfaceFailsLast(env.CATALOGUE_DB)
      .bind(run.id)
      .all(),
  ).resolves.toMatchObject({
    results: [
      {
        request_id: cards.request_id,
        state: "failed",
        failure_code: "official_collection_plan_empty",
      },
    ],
  });
  await expect(
    ingestionQueries.countOfficialSourceCollectionPlansCount(env.CATALOGUE_DB).bind(run.id).first<{ count: number }>(),
  ).resolves.toMatchObject({
    count: 0,
  });
});

test("an Official Source Collection Plan beyond the adapter capacity is rejected without partial admission", async () => {
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "official_collection_plan_capacity_001",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(created.status).toBe(201);
  const run = await created.json<{ id: string }>();
  const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (root === undefined) throw new Error("discovery root request is absent");
  const snapshotId = await retainProductionSnapshot(
    run.id,
    root.request_id,
    root.url,
    utf8("<html>fusion discovery</html>"),
  );
  const observationSetId = "srcobsset_collection_capacity_001";
  await catalogueStore(env.CATALOGUE_DB).batch([
    sourceEvidenceQueries
      .insertSourceParseOperationsForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(env.CATALOGUE_DB)
      .bind(
        "srcparse_collection_capacity_001",
        snapshotId,
        "official_collection_plan_capacity_parse_001",
        observationSetId,
        `source-observation-sets/${observationSetId}.json`,
      ),
    sourceEvidenceQueries
      .insertSourceObservationSetsForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(env.CATALOGUE_DB)
      .bind(
        observationSetId,
        "srcparse_collection_capacity_001",
        snapshotId,
        `source-observation-sets/${observationSetId}.json`,
      ),
  ]);
  // Fill the Source Lineage with retained unique request identities up to
  // the exact fusion-world-en@9 capacity (the discovery root is the
  // 15,000th). The immutable-plan trigger admits a source_requests row only
  // through a matching retained discovery plan row, so retain those first.
  await catalogueStore(env.CATALOGUE_DB).batch([
    sourceEvidenceQueries
      .inspectFillerForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(env.CATALOGUE_DB)
      .bind(run.id, root.request_id),
    sourceEvidenceQueries
      .insertSourceRequestsForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(env.CATALOGUE_DB)
      .bind(run.id),
  ]);

  const collectionRequests = [
    {
      id: "fusion-world-en:cards",
      method: "GET" as const,
      url: "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true",
      headers: { accept: "text/html" },
      representation_fingerprint: "f".repeat(64),
      surface: "cards",
    },
  ];
  await expect(
    persistOfficialSourceCollectionPlan(catalogueStore(env.CATALOGUE_DB), run.id, observationSetId, collectionRequests),
  ).rejects.toMatchObject({ code: "source_discovery_too_large" });
  await expect(
    ingestionQueries.countOfficialSourceCollectionPlansCount(env.CATALOGUE_DB).bind(run.id).first<{ count: number }>(),
  ).resolves.toMatchObject({
    count: 0,
  });
  await expect(
    sourceEvidenceQueries.countSourceRequestsCount(env.CATALOGUE_DB).bind(run.id).first<{ count: number }>(),
  ).resolves.toMatchObject({
    count: 15_000,
  });
  // The rejection is deterministic: replaying the identical admission keeps
  // failing closed without partially inserting the plan or its requests.
  await expect(
    persistOfficialSourceCollectionPlan(catalogueStore(env.CATALOGUE_DB), run.id, observationSetId, collectionRequests),
  ).rejects.toMatchObject({ code: "source_discovery_too_large" });
  await expect(
    sourceEvidenceQueries
      .countSourceRequestsCountForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(env.CATALOGUE_DB)
      .bind(run.id)
      .first<{ count: number }>(),
  ).resolves.toMatchObject({
    count: 0,
  });
}, 30_000);

test.each([true, false])(
  "bulk Official Source admission covers 449 requests atomically (valid tail: %s)",
  async (validTail) => {
    const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@9",
      idempotency_key: `official_collection_plan_bulk_${validTail}`,
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    });
    expect(created.status).toBe(201);
    const run = await created.json<{ id: string }>();
    const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
    if (root === undefined) throw new Error("discovery root request is absent");
    const snapshotId = await retainProductionSnapshot(
      run.id,
      root.request_id,
      root.url,
      utf8(`<html>fusion bulk discovery ${validTail}</html>`),
    );
    const observationSetId = `srcobsset_collection_bulk_${validTail}`;
    await catalogueStore(env.CATALOGUE_DB).batch([
      sourceEvidenceQueries
        .insertSourceParseOperationsForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(
          env.CATALOGUE_DB,
        )
        .bind(
          `srcparse_collection_bulk_${validTail}`,
          snapshotId,
          `official_collection_plan_bulk_parse_${validTail}`,
          observationSetId,
          `source-observation-sets/${observationSetId}.json`,
        ),
      sourceEvidenceQueries
        .insertSourceObservationSetsForOfficialSourceCollectionPlanBeyondAdapterCapacityRejectedWithout(
          env.CATALOGUE_DB,
        )
        .bind(
          observationSetId,
          `srcparse_collection_bulk_${validTail}`,
          snapshotId,
          `source-observation-sets/${observationSetId}.json`,
        ),
    ]);

    const collectionRequests = Array.from({ length: 449 }, (_, index) => ({
      id: `fusion-world-en:bulk-${index}`,
      method: "GET" as const,
      url: `https://www.dbs-cardgame.com/fw/en/cardlist/?page=${index}`,
      headers: { accept: "text/html" },
      representation_fingerprint: "f".repeat(64),
      surface: !validTail && index === 448 ? "" : "cards",
    }));
    const persist = () =>
      persistOfficialSourceCollectionPlan(
        catalogueStore(env.CATALOGUE_DB),
        run.id,
        observationSetId,
        collectionRequests,
      );
    if (validTail) {
      await expect(persist()).resolves.toBeUndefined();
      await expect(persist()).resolves.toBeUndefined();
    } else {
      await expect(persist()).rejects.toThrow("source_request_not_in_immutable_plan");
    }
    await expect(
      ingestionQueries.countOfficialSourceCollectionPlansCount(env.CATALOGUE_DB).bind(run.id).first(),
    ).resolves.toMatchObject({ count: validTail ? 1 : 0 });
    await expect(
      sourceEvidenceQueries.countSourceRequestsCount(env.CATALOGUE_DB).bind(run.id).first(),
    ).resolves.toMatchObject({ count: validTail ? 450 : 1 });
  },
);

test("initial Evidence Plans admit 500 bounded requests in one native transaction", async () => {
  const request = {
    idempotency_key: "initial_bulk_plan_001",
    plans: Array.from({ length: 5 }, (_, plan) => ({
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@3",
      requests: Array.from({ length: 100 }, (_, index) => ({
        id: `bulk-${plan}-${index}`,
        url: `https://bulk-fixture.invalid/cards/${plan}/${index}`,
      })),
    })),
  };
  const run = await startEvidenceRun(catalogueStore(env.CATALOGUE_DB), request);
  expect(typeof run.id).toBe("string");
  await expect(
    sourceEvidenceQueries.countSourceRequestsCount(env.CATALOGUE_DB).bind(run.id).first(),
  ).resolves.toMatchObject({ count: 500 });
  const replay = await startEvidenceRun(catalogueStore(env.CATALOGUE_DB), request);
  expect(replay.id).toBe(run.id);
});
