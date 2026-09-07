import { expect, test } from "vitest";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
import { canonicalJson, sha256 } from "../../../src/catalogue/shared";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import * as curatedQueries from "./query-helpers/curated";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import {
  approve,
  collect,
  exportComponentRecords,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  requiredFirst,
  requiredString,
  testEnv,
  waitForRunState,
} from "./reconciliation-helpers";

installReconciliationSuite();

async function waitForNativeCandidate(runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const listed = await get(`/v1/ingestion-runs/${runId}/game-candidates`);
    expect(listed.response.status).toBe(200);
    const candidates = listed.document.candidates as Record<string, unknown>[];
    if (candidates.length > 0) {
      expect(candidates).toHaveLength(1);
      const candidate = await get(`/v1/game-candidates/${candidates[0]!.id}`);
      expect(candidate.response.status).toBe(200);
      if (candidate.document.state !== "preparing") {
        expect(candidate.document).toMatchObject({
          state: "sealed",
          ingestion_run_id: runId,
          supported_game: "fusion-world",
          manifest_digest: expect.any(String),
        });
        return candidate.document;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`collection ${runId} did not seal its native candidate`);
}

async function abandonNativeCandidate(candidate: Record<string, unknown>) {
  expect(
    (
      await post(`/v1/game-candidates/${candidate.id}/abandon`, {
        generation: candidate.generation,
        idempotency_key: `abandon-${candidate.id}`,
      })
    ).response.status,
  ).toBe(200);
}

test("a complete zero-match blocks publication unless retained evidence proves a demonstrably novel appearance", async () => {
  const run = await collect("/reconciliation/not-demonstrably-novel", "reconcile-not-novel");
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    state: "failed",
    diagnostics: [
      {
        code: "printing_match_insufficient_evidence",
        source_observation_id: expect.stringMatching(/^srcobs_/),
      },
    ],
  });
  const inspected = await get(`/v1/ingestion-runs/${run.id}/candidate`);
  expect(inspected.response.status).toBe(200);
  expect(inspected.document).toMatchObject({
    run_id: run.id,
    candidate_digest: requiredString(blocked.document, "candidate_digest"),
    diff: {
      printings: {
        added: expect.any(Array),
      },
    },
  });
  const retried = await post(`/v1/ingestion-runs/${run.id}/retry`, {
    idempotency_key: "blocked-candidate-generic-retry",
  });
  expect(retried.response.status).toBe(409);
  expect(retried.document).toMatchObject({
    code: "evidence_retry_required",
  });
  const approval = await post(`/v1/ingestion-runs/${run.id}/approval`, {
    candidate_digest: "a".repeat(64),
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: "blocked-approval",
  });
  expect(approval.response.status).toBe(409);
  expect(approval.document).toMatchObject({
    code: "run_not_awaiting_approval",
  });
});

test("a novel flag without structurally complete adapter and Printing Image evidence blocks publication", async () => {
  const run = await collect("/reconciliation/incomplete-appearance", "reconcile-incomplete-appearance");
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    diagnostics: [
      {
        code: "printing_match_insufficient_evidence",
        detail: expect.stringContaining("structurally complete"),
      },
    ],
  });
});

test("immutable Observation Set counts, not an observation novelty assertion, decide structural completeness", async () => {
  const run = await collect("/reconciliation/set-count-mismatch", "reconcile-set-count-mismatch");
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining("incomplete declared/parsed count closure"),
      },
    ],
  });
});

test("unknown controlled vocabulary remains retained evidence, warns, and stays out of the Game Profile", async () => {
  const run = await collect("/reconciliation/unknown-vocabulary", "reconcile-unknown-vocabulary");
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  expect(reconciled.response.status).toBe(200);
  const warnings = reconciled.document.warnings;
  expect(Array.isArray(warnings) ? warnings : []).toContainEqual(
    expect.objectContaining({
      code: "unknown_source_vocabulary",
      profile: "one-piece@1",
      path: "printing.illustration_types",
      raw_value: "etched-future",
    }),
  );
  expect(Array.isArray(warnings) ? warnings : []).toContainEqual(
    expect.objectContaining({
      code: "unknown_source_field",
      path: "new_official_label",
      raw_value: "Bandai-added-value",
    }),
  );
  expect(requiredFirst(reconciled.document, "printings")).toMatchObject({
    game_data: {
      profile: "one-piece@1",
      attributes: { illustration_types: [] },
    },
  });
  const observationSetId = requiredString(requiredFirst(run.document, "observation_sets"), "id");
  const retained = await get(`/v1/source-observation-sets/${observationSetId}/content`);
  expect(retained.response.status).toBe(200);
  expect(JSON.stringify(retained.document)).toContain("etched-future");
  const rejected = await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
    idempotency_key: "reject-unknown-vocabulary",
  });
  expect(rejected.response.status).toBe(200);
});

test.each([
  {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
    scenario: "profile-fusion-world",
    profile: "fusion-world@1",
    identity: "FB01-001",
    printingCount: 1,
  },
  {
    game: "digimon",
    lineage: "digimon-en",
    adapter: "fixture-digimon-json@2",
    scenario: "profile-digimon",
    profile: "digimon@1",
    identity: "BT1-001",
    printingCount: 1,
  },
  {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@2",
    scenario: "profile-gundam",
    profile: "gundam@1",
    identity: "GD01-001",
    printingCount: 1,
  },
  {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-json@3",
    scenario: "profile-don",
    profile: "one-piece@1",
    identity: "DON!!",
    printingCount: 0,
  },
])(
  "publishes accepted $profile identity without one-printing assumptions",
  async ({ game, lineage, adapter, scenario, profile, identity, printingCount }) => {
    const run = await collect(`/reconciliation/${scenario}`, `reconcile-${scenario}`, { game, lineage, adapter });
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const card = requiredFirst(reconciled.document, "cards");
    expect(card).toMatchObject({
      game,
      official_identity: {
        kind: identity === "DON!!" ? "functional_designation" : "card_number",
        value: identity,
      },
      game_data: { profile },
    });
    expect(Array.isArray(reconciled.document.printings) ? reconciled.document.printings : []).toHaveLength(
      printingCount,
    );
    const published = await approve(reconciled.document);
    if (published.response.status !== 200) {
      throw new Error(JSON.stringify(published.document));
    }
    expect(published.response.status).toBe(200);
  },
);

test("a partial-game publication carries an unselected curation and its immutable ledger forward", async () => {
  const digimonSource = {
    game: "digimon",
    lineage: "digimon-en",
    adapter: "fixture-digimon-json@2",
  };
  const initial = await collect(
    "/reconciliation/profile-digimon",
    `partial-curation-initial-${crypto.randomUUID()}`,
    digimonSource,
  );
  const initialReconciled = await reconcile(initial.id);
  const initialPublication = await approve(initialReconciled.document);
  expect(initialPublication.response.status).toBe(200);
  const initialRevision = requiredString(initialPublication.document, "resulting_revision_id");
  const officialCard = requiredFirst(initialReconciled.document, "cards");
  const officialName = requiredString(officialCard, "name");
  const retainedEvidence = await reconciliationQueries
    .readReconciliationCandidatesSourceObservationId(testEnv.CATALOGUE_DB)
    .bind(initial.id)
    .first<{ source_observation_id: string }>();
  expect(retainedEvidence?.source_observation_id).toMatch(/^srcobs_/u);
  const proposal = {
    game: "digimon",
    target: {
      kind: "field",
      entity_type: "card",
      entity_id: requiredString(officialCard, "id"),
      path: "/name",
    },
    assertion: { kind: "field", value: "Owner-reviewed Digimon Name" },
    rationale: "Preserve this Digimon correction across partial refreshes.",
    evidence: [
      {
        kind: "source_observation",
        id: retainedEvidence!.source_observation_id,
      },
    ],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256(new TextEncoder().encode(canonicalJson(officialName))),
    supersedes_revision_id: null,
  };
  const created = await post("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: initialRevision,
    proposal,
    proposal_digest: await sha256(new TextEncoder().encode(canonicalJson(proposal))),
    idempotency_key: `partial-curation-create-${crypto.randomUUID()}`,
  });
  expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  const curatedRevisionId = requiredString(created.document, "curated_revision_id");

  const curatedRun = await collect(
    "/reconciliation/profile-digimon",
    `partial-curation-apply-${crypto.randomUUID()}`,
    digimonSource,
  );
  const curatedCandidate = await reconcile(curatedRun.id);
  expect(requiredFirst(curatedCandidate.document, "cards")).toMatchObject({
    name: "Owner-reviewed Digimon Name",
    curated_provenance: [{ curated_revision_id: curatedRevisionId }],
  });
  const curatedPublication = await approve(curatedCandidate.document);
  expect(curatedPublication.response.status).toBe(200);
  const curatedCatalogueRevision = requiredString(curatedPublication.document, "resulting_revision_id");

  const partialRun = await collect("/reconciliation/base", `partial-curation-one-piece-${crypto.randomUUID()}`);
  const partialCandidate = await reconcile(partialRun.id);
  const partialPublication = await approve(partialCandidate.document);
  expect(partialPublication.response.status).toBe(200);
  const partialCatalogueRevision = requiredString(partialPublication.document, "resulting_revision_id");
  const [before, after, ledger] = await Promise.all([
    publishedCatalogueQueries
      .readRevisionCardsDocumentJson(testEnv.CATALOGUE_DB)
      .bind(curatedCatalogueRevision, requiredString(officialCard, "id"))
      .first<{ document_json: string }>(),
    publishedCatalogueQueries
      .readRevisionCardsDocumentJson(testEnv.CATALOGUE_DB)
      .bind(partialCatalogueRevision, requiredString(officialCard, "id"))
      .first<{ document_json: string }>(),
    curatedQueries
      .readCatalogueCuratedProvenanceCuratedRevisionId(testEnv.CATALOGUE_DB)
      .bind(partialCatalogueRevision, curatedRevisionId)
      .first<{ curated_revision_id: string }>(),
  ]);
  expect(JSON.parse(after?.document_json ?? "{}")).toEqual(JSON.parse(before?.document_json ?? "{}"));
  expect(JSON.parse(after?.document_json ?? "{}")).toMatchObject({
    data: {
      name: "Owner-reviewed Digimon Name",
      curated_provenance: [{ curated_revision_id: curatedRevisionId }],
    },
  });
  expect(ledger).toEqual({ curated_revision_id: curatedRevisionId });
}, 60_000);

test("production adapters retain parser-bound coverage proof for reconciliation", async () => {
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "reconcile-production-adapter-without-coverage",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(started.response.status).toBe(201);
  const run = {
    id: requiredString(started.document, "id"),
  };
  const resumed = await post(`/v1/ingestion-runs/${run.id}/collection/resume`, {});
  expect(resumed.response.status).toBe(202);
  const candidate = await waitForNativeCandidate(run.id);
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
  const partitionPage = await get(`/v1/game-candidates/${candidate.id}/partitions`);
  expect(partitionPage.response.status).toBe(200);
  expect(partitionPage.document.next_cursor).toBeNull();
  const partitions = partitionPage.document.partitions as { kind: string; record_count: number }[];
  expect(
    partitions
      .filter(({ kind }) => kind === "cards" || kind === "printings")
      .reduce((count, partition) => count + partition.record_count, 0),
  ).toBe(0);
  await abandonNativeCandidate(candidate);
});

test("new collection rejects an unregistered adapter version while retained snapshots reparse with their exact capturing version", async () => {
  const blocked = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@8",
    idempotency_key: "reject-unregistered-production-adapter",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({ code: "adapter_not_supported" });

  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "active-adapter-retained-reparse-source",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await post(`/v1/ingestion-runs/${runId}/collection/resume`, {})).response.status).toBe(202);

  const candidate = await waitForNativeCandidate(runId);
  const snapshot = await sourceEvidenceQueries
    .readSourceSnapshotsId(testEnv.CATALOGUE_DB)
    .bind(runId)
    .first<{ id: string }>();
  if (snapshot === null) throw new Error("Retained Product snapshot is absent");
  const reparsed = await post(`/v1/source-snapshots/${snapshot.id}/observations`, {
    adapter_version: "fusion-world-en@9",
    idempotency_key: "capturing-adapter-retained-reparse",
  });
  expect(reparsed.response.status).toBe(201);
  expect(reparsed.document).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fusion-world-en@9",
  });
  await abandonNativeCandidate(candidate);
}, 30_000);

test("complete image evidence publishes an unidentified artwork once without collapsing a new locator", async () => {
  const collectVariant = async (
    variant: "base" | "base-reencoded" | "no-artwork-id" | "alternate" | "alternate-two",
    expectedState = "awaiting_approval",
  ) => {
    const requests = officialSourceDiscoveryRequests("digimon-en").map((sourceRequest) => ({
      ...sourceRequest,
      headers: {
        ...sourceRequest.headers,
        "user-agent": `card-keepr-artwork-digest-${variant}`,
      },
    }));
    const started = await post("/v1/ingestion-runs/evidence", {
      supported_game: "digimon",
      source_lineage: "digimon-en",
      adapter_version: "digimon-en@7",
      idempotency_key: `digimon-artwork-digest-${variant}`,
      requests,
    });
    expect(started.response.status).toBe(201);
    const runId = requiredString(started.document, "id");
    // This test exercises compatibility publication; production parents now prepare native candidates.
    await collectFixtureEvidence(
      testEnv.CATALOGUE_DB,
      testEnv.EVIDENCE_OBJECTS,
      testEnv.OFFICIAL_SOURCE_TRANSPORT,
      runId,
    );
    await reconcile(runId, {}, 20_000);
    const state = await waitForRunState(runId, expectedState, 20_000, 250);
    if (expectedState === "failed") return state;
    const candidate = await get(`/v1/ingestion-runs/${runId}/candidate`);
    expect(candidate.response.status).toBe(200);
    return candidate.document;
  };

  const first = await collectVariant("base");
  expect(first).toMatchObject({
    diff: { printings: { added: [expect.any(String)] } },
  });
  const firstPrintingId = (first.diff as { printings: { added: string[] } }).printings.added[0]!;
  expect((await approve(first)).response.status).toBe(200);

  const reencoded = await collectVariant("base-reencoded");
  expect(reencoded).toMatchObject({
    diff: { printings: { added: [] } },
  });
  expect((await approve(reencoded)).response.status).toBe(200);

  const locatorOnly = await collectVariant("no-artwork-id", "failed");
  expect(locatorOnly).toMatchObject({
    state: "failed",
    failure_code: "printing_reconciliation_blocked",
  });

  const second = await collectVariant("alternate");
  expect(second).toMatchObject({
    diff: { printings: { added: [expect.any(String)] } },
  });
  const secondPrintingId = (second.diff as { printings: { added: string[] } }).printings.added[0]!;
  expect((await approve(second)).response.status).toBe(200);

  const third = await collectVariant("alternate-two");
  expect(third).toMatchObject({
    diff: { printings: { added: [expect.any(String)] } },
  });
  const thirdPrintingId = (third.diff as { printings: { added: string[] } }).printings.added[0]!;
  const targetPrintingIds = new Set([firstPrintingId, secondPrintingId, thirdPrintingId]);
  expect(targetPrintingIds.size).toBe(3);
  const published = await approve(third);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const [printings, images] = await Promise.all([
    exportComponentRecords(revisionId, "printings"),
    exportComponentRecords(revisionId, "printing-images"),
  ]);
  const targetPrintings = printings.filter(({ id }) => targetPrintingIds.has(String(id)));
  const targetImages = images.filter(({ printing_id }) => targetPrintingIds.has(String(printing_id)));
  expect(targetPrintings).toHaveLength(3);
  expect(new Set(targetPrintings.map(({ id }) => id))).toEqual(targetPrintingIds);
  expect(targetImages).toHaveLength(4);
  expect(new Set(targetImages.map(({ printing_id }) => printing_id))).toEqual(targetPrintingIds);
  expect(new Set(targetImages.map(({ content_sha256 }) => content_sha256)).size).toBe(4);
  expect(
    targetImages
      .filter(({ printing_id }) => printing_id === firstPrintingId)
      .map(({ width, height }) => `${width}x${height}`)
      .sort(),
  ).toEqual(["1x1", "2x2"]);
  // Publication projects the content facts the api serves onto the revision
  // row, so the read cluster never joins reconciled_printing_images
  // (issue #98).
  const projectedImages = await reconciliationQueries
    .readRevisionPrintingImagesReconciledMediaTypeReconciledContentSha256(testEnv.CATALOGUE_DB)
    .bind(revisionId)
    .all<Record<string, string | number | null>>();
  expect(projectedImages.results.length).toBeGreaterThanOrEqual(4);
  for (const row of projectedImages.results) {
    expect(row.media_type).toBe(row.reconciled_media_type);
    expect(row.content_sha256).toBe(row.reconciled_content_sha256);
    expect(row.content_byte_length).toBe(row.reconciled_content_byte_length);
    expect(row.object_key).toBe(row.reconciled_object_key);
  }
}, 120_000);

test("production Evidence Plans bind discovery identity to its exact Official Source URL", async () => {
  const requests = officialSourceDiscoveryRequests("one-piece-en").map((request) => ({ ...request }));
  requests[0]!.url = "https://official-source.invalid/one-piece-en/products";
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "forged-production-surface-url",
    requests,
  });
  expect(started.response.status).toBe(422);
  expect(started.document).toMatchObject({
    code: "source_surface_binding_mismatch",
  });
});

test("the source-plan route rejects unregistered adapters without creating provenance", async () => {
  const blocked = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "unregistered-source-adapter@1",
    idempotency_key: "production-route-fixture-bypass",
    requests: [
      {
        id: "cards",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/base",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_not_supported",
  });
  const retained = await sourceEvidenceQueries
    .countIngestionEvidencePlansCount(testEnv.CATALOGUE_DB)
    .first<{ count: number }>();
  expect(retained?.count).toBe(0);
});

test("the production Worker has no route capable of injecting synthetic fixture plans", async () => {
  const blocked = await post("/v1/internal/fixture-ingestion-runs/evidence", {});
  expect(blocked.response.status).toBe(404);
  expect(blocked.document).toMatchObject({ code: "not_found" });

  const legacyFixturePublication = await post("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "production-fixture-publication-bypass",
  });
  expect(legacyFixturePublication.response.status).toBe(404);
  expect(legacyFixturePublication.document).toMatchObject({
    code: "not_found",
  });
  const retained = await ingestionQueries
    .countIngestionRunsCountForProductionWorkerHasNoRouteCapableInjectingSyntheticFixture(testEnv.CATALOGUE_DB)
    .first<{ count: number }>();
  expect(retained?.count).toBe(0);
});

test("one complete retained set can publish multiple Printings without collapsing their identities", async () => {
  const run = await collect("/reconciliation/multi-printing", "reconcile-multi-printing");
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toHaveLength(2);
  const printingIds = (reconciled.document.printings as Record<string, unknown>[]).map((printing) => printing.id);
  expect(new Set(printingIds).size).toBe(2);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});

test("Product lifecycle aggregates every related Printing deterministically", async () => {
  const firstRun = await collect("/reconciliation/product-lifecycle-first", "reconcile-product-lifecycle-first");
  const first = await reconcile(firstRun.id);
  const firstPublished = await approve(first.document);
  const firstRevision = requiredString(firstPublished.document, "resulting_revision_id");

  const multipleRun = await collect(
    "/reconciliation/product-lifecycle-multiple",
    "reconcile-product-lifecycle-multiple",
  );
  const multiple = await reconcile(multipleRun.id);
  const multiplePublished = await approve(multiple.document);
  const latestRevision = requiredString(multiplePublished.document, "resulting_revision_id");
  const product = (await exportComponentRecords(latestRevision, "products")).find(
    (record) => record.game === "one-piece" && record.official_code === "product_lifecycle_shared",
  );
  expect(product).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: latestRevision,
      withdrawn: false,
    },
  });
});

test("the profile registry strips and warns on unknown nested fields while enforcing exact numeric types", async () => {
  const warningRun = await collect("/reconciliation/profile-nested-unknown", "reconcile-profile-nested-unknown", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const warned = await reconcile(warningRun.id);
  expect(warned.response.status).toBe(200);
  expect(warned.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "unknown_source_field",
        path: "card.specified_cost[0].new_metric",
        raw_value: "retained raw",
      }),
      expect.objectContaining({
        code: "unknown_source_field",
        path: "card.skills[0].new_label",
        raw_value: "retained raw",
      }),
    ]),
  );
  expect(JSON.stringify(requiredFirst(warned.document, "cards"))).not.toContain("new_metric");
  await post(`/v1/ingestion-runs/${warningRun.id}/rejection`, {
    candidate_digest: requiredString(warned.document, "candidate_digest"),
    idempotency_key: "reject-nested-profile-warning",
  });

  const invalidRun = await collect("/reconciliation/profile-invalid-number", "reconcile-profile-invalid-number", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const invalid = await reconcile(invalidRun.id);
  expect(invalid.response.status).toBe(409);
  expect(invalid.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining("card.cost"),
      },
    ],
  });
});
