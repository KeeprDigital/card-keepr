import { catalogueStore } from "../../../src/catalogue/shared";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import * as ingestionQueries from "./query-helpers/ingestion";
import { expect, test } from "vitest";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
import { type CatalogueBackupWorkflowParams } from "../../../src/catalogue/backup-recovery";
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
  const plans = await reconciliationQueries
    .readReconciliationCandidatesRequestIdSourceSnapshotId(testEnv.CATALOGUE_DB)
    .bind(run.id)
    .all<{
      request_id: string;
      source_snapshot_id: string;
      source_observation_set_id: string;
    }>();
  expect(plans.results.map((row) => row.request_id)).toEqual(["partition-a", "partition-b"]);
  expect(new Set(plans.results.map((row) => row.source_snapshot_id)).size).toBe(2);
  expect(new Set(plans.results.map((row) => row.source_observation_set_id)).size).toBe(2);
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
  const retained = await sourceEvidenceQueries
    .readSourceObservationSetsContentObjectKey(testEnv.CATALOGUE_DB)
    .bind(run.id)
    .all<{ content_object_key: string }>();
  expect(retained.results).toHaveLength(3);
  await sourceEvidenceQueries.dropSourceObservationSetsAreImmutableOnUpdate(testEnv.CATALOGUE_DB).run();
  await sourceEvidenceQueries.setSourceObservationSetsContentByteLength(testEnv.CATALOGUE_DB).bind(run.id).run();
  await sourceEvidenceQueries.createSourceObservationSetsAreImmutableOnUpdate(testEnv.CATALOGUE_DB).run();
  await testEnv.EVIDENCE_OBJECTS.delete(retained.results[0]!.content_object_key);

  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [
      expect.objectContaining({
        code: "retained_evidence_invalid",
        detail: expect.stringContaining("aggregate reconciliation byte budget"),
      }),
    ],
  });
  expect(JSON.stringify(blocked.document)).not.toContain("bytes are unavailable");
});

test("empty first, middle, and last partitions remain durable and digest-bound", async () => {
  for (const emptyIndex of [0, 1, 2]) {
    const requests = ["base", "new-locator", "base"].map((scenario, index) => ({
      id: `partition-${index}`,
      scenario: index === emptyIndex ? "complete-empty-lineage" : scenario,
    }));
    const run = await collectRequests(requests, `durable-empty-partition-${emptyIndex}`);
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const partitions = await reconciliationQueries
      .readReconciliationEvidencePartitionsSequenceNumberRequestId(testEnv.CATALOGUE_DB)
      .bind(run.id)
      .all<{
        sequence_number: number;
        request_id: string;
        source_snapshot_id: string;
        source_observation_set_id: string;
      }>();
    expect(partitions.results.map(({ request_id }) => request_id)).toEqual(requests.map(({ id }) => id));
    expect(
      partitions.results.every(
        (row) =>
          row.source_snapshot_id.startsWith("srcsnap_") && row.source_observation_set_id.startsWith("srcobsset_"),
      ),
    ).toBe(true);
    const digest = await reconciliationQueries
      .readReconciliationPayloadChunksValue(testEnv.CATALOGUE_DB)
      .bind(run.id)
      .first<{ value: string }>();
    expect(digest?.value).toContain('"evidence_partitions"');
    for (const request of requests) {
      expect(digest?.value).toContain(`"requestId":"${request.id}"`);
    }
    await post(`/v1/ingestion-runs/${run.id}/rejection`, {
      candidate_digest: requiredString(reconciled.document, "candidate_digest"),
      idempotency_key: `reject-durable-empty-${emptyIndex}`,
    });
  }
}, 30_000);

test("unplanned requests fail at D1 while duplicate and unplanned observation sets fail reconciliation", async () => {
  const missing = await collectRequests([{ id: "partition-a", scenario: "base" }], "multi-request-missing-coverage");
  await expect(
    sourceEvidenceQueries
      .insertSourceRequestsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(testEnv.CATALOGUE_DB)
      .bind(missing.id)
      .run(),
  ).rejects.toThrow(/source_request_not_in_immutable_plan/);
  const exact = await reconcile(missing.id);
  expect(exact.response.status).toBe(200);
  await post(`/v1/ingestion-runs/${missing.id}/rejection`, {
    candidate_digest: requiredString(exact.document, "candidate_digest"),
    idempotency_key: "reject-exact-plan-after-unplanned-insert",
  });

  const duplicate = await collectRequests([{ id: "partition-a", scenario: "base" }], "multi-request-duplicate-set");
  const duplicateSuffix = crypto.randomUUID();
  await sourceEvidenceQueries
    .insertSourceParseOperationsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(testEnv.CATALOGUE_DB)
    .bind(
      `parse_${duplicateSuffix}`,
      `duplicate-${duplicateSuffix}`,
      `srcobsset_${duplicateSuffix}`,
      `source-observations/duplicate-${duplicateSuffix}.json`,
      duplicate.id,
    )
    .run();
  await sourceEvidenceQueries
    .insertSourceObservationSetsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(testEnv.CATALOGUE_DB)
    .bind(
      `srcobsset_${duplicateSuffix}`,
      `parse_${duplicateSuffix}`,
      `source-observations/duplicate-${duplicateSuffix}.json`,
      duplicate.id,
    )
    .run();
  await expectRetainedEvidenceInvalid(duplicate.id, "requires exactly one collection Source Observation Set");

  const unplanned = await collectRequests([{ id: "partition-a", scenario: "base" }], "multi-request-unplanned-set");
  const rogue = crypto.randomUUID();
  await sourceEvidenceQueries
    .insertSourceFetchAttemptsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(testEnv.CATALOGUE_DB)
    .bind(`fetch_${rogue}`, unplanned.id)
    .run();
  await sourceEvidenceQueries
    .insertSourceSnapshotsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservation(testEnv.CATALOGUE_DB)
    .bind(`snapshot_${rogue}`, `fetch_${rogue}`, unplanned.id)
    .run();
  await sourceEvidenceQueries
    .insertSourceParseOperationsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservationWithCollection(
      testEnv.CATALOGUE_DB,
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
  await sourceEvidenceQueries
    .insertSourceObservationSetsForUnplannedRequestsFailAtD1WhileDuplicateUnplannedObservationWithPartitionA(
      testEnv.CATALOGUE_DB,
    )
    .bind(
      `srcobsset_${rogue}`,
      `parse_${rogue}`,
      `snapshot_${rogue}`,
      `source-observations/rogue-${rogue}.json`,
      unplanned.id,
    )
    .run();
  await expectRetainedEvidenceInvalid(unplanned.id, "Unplanned Source Observation Set");
});

test("recovery health gates fixture evidence injection and reconciliation before mutation", async () => {
  await ingestionQueries.setOperationStateRecoveryHealth(testEnv.CATALOGUE_DB).run();
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
  const blockedMutation = await ingestionQueries
    .countIngestionRuns(testEnv.CATALOGUE_DB)
    .first<{ runs: number; active_ingestion_run_id: string | null }>();
  expect(blockedMutation).toEqual({
    runs: 0,
    active_ingestion_run_id: null,
  });
  await ingestionQueries
    .setOperationStateRecoveryHealthForRecoveryHealthGatesFixtureEvidenceInjectionReconciliationBeforeMutation(
      testEnv.CATALOGUE_DB,
    )
    .run();
  const run = await collect("/reconciliation/base", "blocked-recovery-reconciliation");
  await ingestionQueries.setOperationStateRecoveryHealth(testEnv.CATALOGUE_DB).run();
  const blockedReconciliation = await reconcile(run.id);
  expect(blockedReconciliation.response.status).toBe(409);
  expect(blockedReconciliation.document).toMatchObject({
    code: "recovery_not_verified",
  });
  await ingestionQueries
    .setOperationStateRecoveryHealthForRecoveryHealthGatesFixtureEvidenceInjectionReconciliationBeforeMutation(
      testEnv.CATALOGUE_DB,
    )
    .run();
  const resumed = await reconcile(run.id, {}, 45_000);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(resumed.document, "candidate_digest"),
    idempotency_key: "reject-after-recovery-restored",
  });
}, 60_000);

test("degraded recovery permits evidence collection starts and retries while blocked recovery does not", async () => {
  await ingestionQueries
    .setOperationStateRecoveryHealthForDegradedRecoveryPermitsEvidenceCollectionStartsRetriesWhileBlocked(
      testEnv.CATALOGUE_DB,
    )
    .run();
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
    ingestionQueries.setIngestionRunsStateTerminalAt(testEnv.CATALOGUE_DB).bind(sourceRunId),
    ingestionQueries.setOperationStateActiveIngestionRunIdRecoveryHealth(testEnv.CATALOGUE_DB),
  ]);
  const retried = await post(`/v1/ingestion-runs/${sourceRunId}/collection/retry`, {
    idempotency_key: "degraded-recovery-retry",
  });
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
    plans: [
      {
        supported_game: "gundam",
        source_lineage: sourceLineage,
        adapter_version: adapterVersion,
        requests: officialSourceDiscoveryRequests(sourceLineage),
      },
    ],
    idempotency_key: `gundam-one-lineage-${crypto.randomUUID()}`,
  });
  expect(oneLocale.response.status).toBe(201);
  expect(oneLocale.document).toMatchObject({
    selected_games: ["gundam"],
    evidence_plans: [
      {
        supported_game: "gundam",
        source_lineage: sourceLineage,
        adapter_version: adapterVersion,
      },
    ],
  });
  // Admission is the public behavior under test. Release the test database's
  // singleton lock without depending on a live publisher response so the next
  // independent administration scenario can begin.
  await ingestionQueries.setOperationStateActiveIngestionRunIdForInstallApiSuite(testEnv.CATALOGUE_DB).run();
});

test("publication stays readable while its immutable degraded backup blocks the next approval", async () => {
  const firstRun = await collect("/reconciliation/base", "publication-backup-degraded-first");
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
    new Request(`https://card-keepr.invalid/v1/ingestion-runs/${firstRun.id}/approval`, {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.240",
      },
      body: JSON.stringify({
        candidate_digest: requiredString(firstCandidate.document, "candidate_digest"),
        expected_current_revision_id: requiredString(firstCandidate.document, "expected_current_revision_id"),
        idempotency_key: "publication-backup-degraded-approval",
      }),
    }),
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
  await expect(currentCatalogueStatus(catalogueStore(testEnv.CATALOGUE_DB))).resolves.toMatchObject({
    revisionId,
  });

  await ingestionQueries
    .setOperationStateRecoveryHealthForRecoveryHealthGatesFixtureEvidenceInjectionReconciliationBeforeMutation(
      testEnv.CATALOGUE_DB,
    )
    .run();
  const secondRun = await collect("/reconciliation/profile-one-piece", "publication-backup-degraded-second");
  const secondCandidate = await reconcile(secondRun.id);
  await ingestionQueries
    .setOperationStateRecoveryHealthForDegradedRecoveryPermitsEvidenceCollectionStartsRetriesWhileBlocked(
      testEnv.CATALOGUE_DB,
    )
    .run();
  const blocked = await approve(secondCandidate.document);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({ code: "recovery_not_verified" });
}, 60_000);
