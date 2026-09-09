import { expect, test } from "vitest";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { injectFixturePublication } from "./fixture-plan-injection";
import * as catalogueExportQueries from "./query-helpers/catalogue-export";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import {
  approve,
  collect,
  exportComponentRecords,
  exportManifest,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  requiredFirst,
  requiredRecord,
  requiredString,
  testEnv,
  waitForRunState,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("fresh native provenance retains the consumer revision and export for semantic no-change", async () => {
  const firstRun = await collect("/reconciliation/repeatable", "native-repeatable-first");
  const first = await prepareNativeCandidate(firstRun.id, "one-piece", "catrev_spine_000", "repeatable-first-prepare");
  const firstPublished = await approveNativeCandidate(first, "repeatable-first-publish");
  const revisionId = requiredString(firstPublished.document, "resulting_revision_id");
  const firstExport = await exportManifest(revisionId);
  const firstEvidence = (await get(`/v1/ingestion-runs/${firstRun.id}/evidence`)).document;
  const firstChecks = firstEvidence.source_coverage as Record<string, unknown>[];
  const firstCheck = firstChecks.find(({ source_lineage }) => source_lineage === "one-piece-en");
  expect(firstCheck).toMatchObject({ status: "complete", successful_checked_at: expect.any(String) });

  const secondRun = await collect("/reconciliation/repeatable", "native-repeatable-second");
  const second = await prepareNativeCandidate(secondRun.id, "one-piece", revisionId, "repeatable-second-prepare");
  expect(second.manifest_digest).not.toBe(first.manifest_digest);
  const secondPublished = await approveNativeCandidate(second, "repeatable-second-publish");
  const secondRevision = requiredString(secondPublished.document, "resulting_revision_id");
  const secondEvidence = (await get(`/v1/ingestion-runs/${secondRun.id}/evidence`)).document;
  const secondChecks = secondEvidence.source_coverage as Record<string, unknown>[];
  const secondCheck = secondChecks.find(({ source_lineage }) => source_lineage === "one-piece-en");
  expect(secondCheck).toMatchObject({ status: "complete", successful_checked_at: expect.any(String) });
  expect(String(secondCheck?.successful_checked_at) > String(firstCheck?.successful_checked_at)).toBe(true);
  expect(secondEvidence.snapshots).not.toEqual(firstEvidence.snapshots);
  expect((await get(`/v1/ingestion-runs/${firstRun.id}/evidence`)).document.snapshots).toEqual(firstEvidence.snapshots);
  // A different review manifest is not a consumer content change. Preserve the
  // established revision/export contract without depending on retired run fields.
  expect(secondRevision).toBe(revisionId);
  expect(await exportManifest(secondRevision)).toEqual(firstExport);
});

test("locator and SourceBucket evidence refresh without minting Catalogue Revisions or exports", async () => {
  const baseRun = await collect("/reconciliation/semantic-evidence-base", "reconcile-semantic-evidence-base");
  const base = await reconcile(baseRun.id);
  const printingId = requiredString(requiredFirst(base.document, "printings"), "id");
  const basePublished = await approve(base.document);
  const revisionId = requiredString(basePublished.document, "resulting_revision_id");
  const exportIdentity = await catalogueExportQueries
    .readCatalogueExportsManifestKeyManifestDigestForLocatorSourceBucketEvidenceRefreshWithoutMintingCatalogueRevisionsOr(
      testEnv.CATALOGUE_DB,
    )
    .bind(revisionId)
    .first<{ manifest_key: string; manifest_digest: string }>();
  const revisionCount = await publishedCatalogueQueries
    .countCatalogueRevisionsCount(testEnv.CATALOGUE_DB)
    .first<{ count: number }>();

  const locatorRun = await collect("/reconciliation/semantic-evidence-locator", "reconcile-semantic-evidence-locator");
  const locator = await reconcile(locatorRun.id);
  expect(locator.document.candidate_digest).not.toBe(base.document.candidate_digest);
  const locatorDigests = await ingestionQueries
    .readIngestionRunsCandidateCatalogueDigestContentDigest(testEnv.CATALOGUE_DB)
    .bind(revisionId, locatorRun.id)
    .first<{
      candidate_catalogue_digest: string;
      content_digest: string;
    }>();
  expect(locatorDigests?.candidate_catalogue_digest).toBe(locatorDigests?.content_digest);
  const locatorPublished = await approve(locator.document);
  expect(locatorPublished.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
  const retainedLocator = await reconciliationQueries
    .readReconciledPrintingLocatorsLastObservedRevisionIdCurrent(testEnv.CATALOGUE_DB)
    .bind(printingId)
    .first<{
      last_observed_revision_id: string;
      current: number;
    }>();
  expect(retainedLocator).toMatchObject({
    last_observed_revision_id: revisionId,
    current: 1,
  });
  const retainedLocatorPlan = await reconciliationQueries
    .readReconciliationCandidatesSourceObservationIdForLocatorSourceBucketEvidenceRefreshWithoutMintingCatalogueRevisionsOr(
      testEnv.CATALOGUE_DB,
    )
    .bind(locatorRun.id, printingId)
    .first<{ source_observation_id: string }>();
  expect(retainedLocatorPlan?.source_observation_id).toMatch(/^srcobs_/);

  const sourceBucketRun = await collect(
    "/reconciliation/semantic-evidence-source-bucket",
    "reconcile-semantic-evidence-source-bucket",
  );
  const sourceBucket = await reconcile(sourceBucketRun.id);
  expect(sourceBucket.document.candidate_digest).not.toBe(locator.document.candidate_digest);
  const sourceBucketDigests = await ingestionQueries
    .readIngestionRunsCandidateCatalogueDigestContentDigest(testEnv.CATALOGUE_DB)
    .bind(revisionId, sourceBucketRun.id)
    .first<{
      candidate_catalogue_digest: string;
      content_digest: string;
    }>();
  expect(sourceBucketDigests?.candidate_catalogue_digest).toBe(sourceBucketDigests?.content_digest);
  const sourceBucketPublished = await approve(sourceBucket.document);
  expect(sourceBucketPublished.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
  const retainedBucket = await reconciliationQueries
    .readReconciledPrintingMembershipsSourceObservationIdLastObservedRevisionId(testEnv.CATALOGUE_DB)
    .bind(printingId)
    .first<{
      source_observation_id: string;
      last_observed_revision_id: string;
      current: number;
    }>();
  expect(retainedBucket).toMatchObject({
    source_observation_id: expect.stringMatching(/^srcobs_/),
    last_observed_revision_id: revisionId,
    current: 1,
  });
  const lifecycle = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(lifecycle.document).toMatchObject({
    locators: {
      current: [
        expect.objectContaining({
          locator: "/official/evidence/relocated",
          current: true,
        }),
      ],
      historical: [
        expect.objectContaining({
          locator: "/official/evidence/base",
          current: false,
        }),
      ],
    },
    memberships: {
      current: {
        source_buckets: ["secondary-card-list"],
      },
      historical: {
        source_buckets: [
          expect.objectContaining({
            id: "primary-card-list",
            current: false,
            last_missing_revision_id: revisionId,
          }),
        ],
      },
    },
  });
  expect(JSON.stringify(lifecycle.document.relationship_evidence)).not.toContain("source_bucket");
  const afterRevisionCount = await publishedCatalogueQueries
    .countCatalogueRevisionsCount(testEnv.CATALOGUE_DB)
    .first<{ count: number }>();
  const afterExportIdentity = await catalogueExportQueries
    .readCatalogueExportsManifestKeyManifestDigestForLocatorSourceBucketEvidenceRefreshWithoutMintingCatalogueRevisionsOr(
      testEnv.CATALOGUE_DB,
    )
    .bind(revisionId)
    .first<{ manifest_key: string; manifest_digest: string }>();
  expect(afterRevisionCount).toEqual(revisionCount);
  expect(afterExportIdentity).toEqual(exportIdentity);
});

test("reversed retained observation provenance preserves the semantic relationship result", async () => {
  const forwardRun = await collect("/reconciliation/deterministic-forward", "reconcile-deterministic-forward");
  const forward = await reconcile(forwardRun.id);
  const published = await approve(forward.document);
  const revisionId = requiredString(published.document, "resulting_revision_id");

  const reverseRun = await collect("/reconciliation/deterministic-reverse", "reconcile-deterministic-reverse");
  const reverse = await reconcile(reverseRun.id);
  expect(reverse.document.candidate_digest).not.toBe(forward.document.candidate_digest);
  const repeated = await approve(reverse.document);
  expect(repeated.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
});

test("a known locator with contradictory retained material evidence fails the run before publication", async () => {
  const establishedRun = await collect("/reconciliation/conflict-base", "reconcile-conflict-base");
  const established = await reconcile(establishedRun.id);
  expect(established.response.status).toBe(200);
  await approve(established.document);

  const conflictRun = await collect("/reconciliation/conflict-changed", "reconcile-conflict-changed");
  const conflict = await reconcile(conflictRun.id);
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({
    publishable: false,
    state: "failed",
    diagnostics: [
      {
        code: "printing_match_contradictory",
        locator: "/official/conflict",
      },
    ],
  });
});

test("same-lineage authoritative Card evolution updates canonical facts while preserving identity", async () => {
  const firstRun = await collect("/reconciliation/canonical-base", "reconcile-canonical-base");
  const first = await reconcile(firstRun.id);
  const cardId = requiredString(requiredFirst(first.document, "cards"), "id");
  await approve(first.document);

  const changedRun = await collect("/reconciliation/canonical-name-conflict", "reconcile-canonical-name-conflict");
  const changed = await reconcile(changedRun.id);
  expect(changed.response.status).toBe(200);
  expect(requiredFirst(changed.document, "cards")).toMatchObject({
    id: cardId,
    name: "Unsupported replacement name",
  });
  await approve(changed.document);
  const history = await reconciliationQueries
    .readReconciledCardObservationsSourceLineageCanonicalFactsJson(testEnv.CATALOGUE_DB)
    .bind(cardId)
    .all<{
      source_lineage: string;
      canonical_facts_json: string;
      current: number;
    }>();
  expect(history.results).toHaveLength(2);
  expect(history.results.map(({ current }) => current).sort()).toEqual([0, 1]);
});

test("sequential selected-game publications retain the complete current catalogue across D1 and export", async () => {
  const onePieceRun = await collect("/reconciliation/base", "reconcile-union-one-piece");
  const onePiece = await reconcile(onePieceRun.id);
  const onePieceCard = requiredFirst(onePiece.document, "cards");
  const onePiecePrinting = requiredFirst(onePiece.document, "printings");
  const onePiecePublished = await approve(onePiece.document);
  expect(onePiecePublished.response.status).toBe(200);
  const onePieceRevision = requiredString(onePiecePublished.document, "resulting_revision_id");
  const _firstManifest = await exportManifest(onePieceRevision);

  const fusionRun = await collect("/reconciliation/union-fusion-world", "reconcile-union-fusion-world", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const fusion = await reconcile(fusionRun.id);
  expect(fusion.response.status).toBe(200);
  const candidate = await get(`/v1/ingestion-runs/${fusionRun.id}/candidate`);
  expect(candidate.document).toMatchObject({
    diff: {
      summary: {
        cards_added: 1,
        printings_added: 1,
      },
    },
  });
  const published = await approve(fusion.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const profiles = await exportComponentRecords(revisionId, "game-profiles");
  expect(profiles).toContainEqual(
    expect.objectContaining({
      profile: "fusion-world@1",
      schema: expect.objectContaining({
        additionalProperties: false,
        required: ["card", "printing"],
        properties: expect.objectContaining({
          card: expect.objectContaining({
            additionalProperties: false,
            required: expect.arrayContaining(["card_type", "specified_cost"]),
          }),
        }),
      }),
    }),
  );

  const d1Cards = await publishedCatalogueQueries
    .readRevisionCardsCardId(testEnv.CATALOGUE_DB)
    .bind(revisionId)
    .all<{ card_id: string }>();
  expect(d1Cards.results.length).toBeGreaterThanOrEqual(2);
  expect(d1Cards.results.map(({ card_id }) => card_id)).toContain(requiredString(onePieceCard, "id"));
  const d1Printings = await publishedCatalogueQueries
    .readRevisionPrintingsPrintingId(testEnv.CATALOGUE_DB)
    .bind(revisionId)
    .all<{ printing_id: string }>();
  expect(d1Printings.results.map(({ printing_id }) => printing_id)).toContain(requiredString(onePiecePrinting, "id"));
  expect(await exportComponentRecords(revisionId, "cards")).toHaveLength(d1Cards.results.length);
  const _fusionSnapshot = await sourceEvidenceQueries
    .readSourceSnapshotsRetrievedAt(testEnv.CATALOGUE_DB)
    .bind(fusionRun.id)
    .first<{ retrieved_at: string }>();
  const secondManifest = await exportManifest(revisionId);
  expect(secondManifest).not.toHaveProperty("source_freshness");
  const products = await exportComponentRecords(revisionId, "products");
  const sharedProducts = products.filter(
    (product) =>
      product.official_code === "product_op01" && ["one-piece", "fusion-world"].includes(String(product.game)),
  );
  expect(sharedProducts).toHaveLength(2);
  expect(new Set(sharedProducts.map(({ id }) => id)).size).toBe(2);
  expect(sharedProducts.map(({ game }) => game).sort()).toEqual(["fusion-world", "one-piece"]);
  const relationships = await exportComponentRecords(revisionId, "relationships");
  expect(relationships.every(({ id }) => /^relationship_[a-f0-9]{64}$/.test(String(id)))).toBe(true);
  const sharedProductIds = new Set(sharedProducts.map(({ id }) => id));
  const productTargets = relationships
    .filter(
      ({ relationship_value, to }) =>
        relationship_value === "product_op01" && sharedProductIds.has((to as Record<string, unknown>).id),
    )
    .map(({ to }) => (to as Record<string, unknown>).id);
  expect(new Set(productTargets).size).toBe(2);

  const refreshRun = await collect("/reconciliation/base", "reconcile-union-one-piece-refresh");
  const refresh = await reconcile(refreshRun.id);
  const retainedPlan = await reconciliationQueries
    .readReconciliationCandidatesSourceObservationId(testEnv.CATALOGUE_DB)
    .bind(refreshRun.id)
    .first<{ source_observation_id: string }>();
  const digests = await ingestionQueries
    .readIngestionRunsCandidateDigestCandidateCatalogueDigest(testEnv.CATALOGUE_DB)
    .bind(revisionId, refreshRun.id)
    .first<{
      candidate_digest: string;
      candidate_catalogue_digest: string;
      content_digest: string;
    }>();
  expect(digests?.candidate_digest).toBe(requiredString(refresh.document, "candidate_digest"));
  expect(digests?.candidate_catalogue_digest).toBe(digests?.content_digest);
  const refreshed = await approve(refresh.document);
  expect(refreshed.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
  const refreshedCardObservation = await reconciliationQueries
    .readReconciledCardObservationsSourceObservationIdCatalogueRevisionId(testEnv.CATALOGUE_DB)
    .bind(requiredString(onePieceCard, "id"))
    .first<{
      source_observation_id: string;
      catalogue_revision_id: string;
      current: number;
    }>();
  expect(refreshedCardObservation).toEqual({
    source_observation_id: retainedPlan?.source_observation_id,
    catalogue_revision_id: revisionId,
    current: 1,
  });
  const refreshedMembership = await reconciliationQueries
    .readReconciledPrintingMembershipsSourceObservationIdLastObservedRevisionIdForSequentialSelectedGamePublicationsRetainCompleteCurrentCatalogueAcross(
      testEnv.CATALOGUE_DB,
    )
    .bind(requiredString(onePiecePrinting, "id"))
    .first<{
      source_observation_id: string;
      last_observed_revision_id: string;
      current: number;
    }>();
  expect(refreshedMembership).toEqual({
    source_observation_id: retainedPlan?.source_observation_id,
    last_observed_revision_id: revisionId,
    current: 1,
  });
});

test("candidate inspection reports stable reconciliation matches rather than every entity as added", async () => {
  const firstRun = await collect("/reconciliation/base", "reconcile-inspection-base");
  const first = await reconcile(firstRun.id);
  const firstCard = requiredFirst(first.document, "cards");
  const firstPrinting = requiredFirst(first.document, "printings");
  await approve(first.document);

  const nextRun = await collect("/reconciliation/new-locator", "reconcile-inspection-new-locator");
  const next = await reconcile(nextRun.id);
  const inspected = await get(`/v1/ingestion-runs/${nextRun.id}/candidate`);
  expect(inspected.response.status).toBe(200);
  const inspectedWarnings = (inspected.document.diff as Record<string, unknown>).warnings as Record<string, unknown>[];
  expect(inspectedWarnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "relationship_not_observed",
        printing_id: requiredString(firstPrinting, "id"),
      }),
    ]),
  );
  expect(inspected.document).toMatchObject({
    diff: {
      summary: {
        cards_added: 0,
        printings_added: 0,
      },
      cards: {
        added: [],
        changed: [],
        missing_observations: expect.not.arrayContaining([requiredString(firstCard, "id")]),
      },
      printings: {
        added: [],
        changed: [],
        identity_matches: [requiredString(firstPrinting, "id")],
      },
    },
  });
  await post(`/v1/ingestion-runs/${nextRun.id}/rejection`, {
    candidate_digest: requiredString(next.document, "candidate_digest"),
    idempotency_key: "reject-inspected-candidate",
  });
});

test("generic retry rejects an evidence-backed terminal run so reconciliation provenance cannot be reset", async () => {
  const run = await collect("/reconciliation/base", "reconcile-generic-retry");
  const reconciled = await reconcile(run.id);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
    idempotency_key: "reject-before-generic-retry",
  });

  const retried = await post(`/v1/ingestion-runs/${run.id}/retry`, {
    idempotency_key: "generic-retry-must-not-reset-evidence",
  });
  expect(retried.response.status).toBe(409);
  expect(retried.document).toMatchObject({
    code: "evidence_retry_required",
  });
  const original = await get(`/v1/ingestion-runs/${run.id}`);
  expect(original.document).toMatchObject({
    state: "rejected",
  });
  const retainedCandidate = await reconciliationQueries
    .readReconciliationPayloadChunksCandidateDigest(testEnv.CATALOGUE_DB)
    .bind(run.id)
    .first<{
      candidate_digest: string;
      digest_payload_json: string;
    }>();
  expect(retainedCandidate).toMatchObject({
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
  });
  expect(retainedCandidate?.digest_payload_json).toContain('"catalogue_data"');
  const interveningDocument = await injectFixturePublication(testEnv.CATALOGUE_DB, testEnv.CATALOGUE_EXPORTS, {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "intervening-current-revision",
  });
  const intervening = {
    response: new Response(null, { status: 201 }),
    document: interveningDocument,
  };
  expect(intervening.response.status).toBe(201);
  const interveningPublished = await post(`/v1/ingestion-runs/${requiredString(intervening.document, "id")}/approval`, {
    candidate_digest: requiredString(intervening.document, "candidate_digest"),
    expected_current_revision_id: requiredString(intervening.document, "expected_current_revision_id"),
    idempotency_key: "approve-intervening-current-revision",
  });
  expect(interveningPublished.response.status).toBe(200);
  const currentRevision = requiredString(interveningPublished.document, "resulting_revision_id");
  const evidenceRetry = await post(`/v1/ingestion-runs/${run.id}/collection/retry`, {
    idempotency_key: "linked-retry-retains-evidence-plan",
  });
  expect(evidenceRetry.response.status).toBe(201);
  expect(evidenceRetry.document).toMatchObject({
    state: "collecting",
    linked_run_id: run.id,
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    plan_origin: "production",
    expected_current_revision_id: currentRevision,
  });
  const retryId = requiredString(evidenceRetry.document, "id");
  await collectFixtureEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    testEnv.OFFICIAL_SOURCE_TRANSPORT,
    retryId,
  );
  await waitForRunState(retryId, "parsing");
  const retryCandidate = await reconcile(retryId);
  const rejected = await post(`/v1/ingestion-runs/${retryId}/rejection`, {
    candidate_digest: requiredString(retryCandidate.document, "candidate_digest"),
    idempotency_key: "reject-linked-retry-after-verification",
  });
  expect(rejected.response.status).toBe(200);
}, 30_000);

test("historical locator bindings reactivate only for the same Printing and expose lifecycle evidence", async () => {
  const baseRun = await collect("/reconciliation/locator-binding-base", "locator-binding-base");
  const base = await reconcile(baseRun.id);
  const printingId = requiredString(requiredFirst(base.document, "printings"), "id");
  const basePublished = await approve(base.document);
  const firstRevision = requiredString(basePublished.document, "resulting_revision_id");

  const missingRun = await collect("/reconciliation/complete-empty-lineage", "locator-binding-missing-first");
  const missing = await reconcile(missingRun.id);
  const missingPublished = await approve(missing.document);
  const missingRevision = requiredString(missingPublished.document, "resulting_revision_id");
  const stale = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(stale.document).toMatchObject({
    locators: {
      current: [],
      historical: [
        {
          locator: "/official/locator-binding/stable",
          source_lineage: "one-piece-en",
          variant_key: null,
          first_revision_id: firstRevision,
          last_observed_revision_id: firstRevision,
          current: false,
          last_missing_revision_id: missingRevision,
        },
      ],
    },
  });
  expect(await exportComponentRecords(missingRevision, "printings")).toContainEqual(
    expect.objectContaining({
      id: printingId,
    }),
  );

  const compatibleRun = await collect(
    "/reconciliation/locator-binding-compatible",
    "locator-binding-compatible-return",
  );
  const compatible = await reconcile(compatibleRun.id);
  expect(requiredFirst(compatible.document, "printings")).toMatchObject({
    id: printingId,
  });
  const compatiblePublished = await approve(compatible.document);
  const reactivatedRevision = requiredString(compatiblePublished.document, "resulting_revision_id");
  const reactivated = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(reactivated.document).toMatchObject({
    locators: {
      current: [
        {
          locator: "/official/locator-binding/stable",
          source_lineage: "one-piece-en",
          variant_key: null,
          first_revision_id: firstRevision,
          last_observed_revision_id: reactivatedRevision,
          current: true,
          last_missing_revision_id: null,
        },
      ],
      historical: [],
    },
  });

  const missingAgainRun = await collect("/reconciliation/complete-empty-lineage", "locator-binding-missing-second");
  const missingAgain = await reconcile(missingAgainRun.id);
  const missingAgainPublished = await approve(missingAgain.document);
  const missingAgainRevision = requiredString(missingAgainPublished.document, "resulting_revision_id");
  const incompatibleRun = await collect(
    "/reconciliation/locator-binding-incompatible",
    "locator-binding-incompatible-return",
  );
  const incompatible = await reconcile(incompatibleRun.id);
  expect(incompatible.response.status).toBe(409);
  expect(incompatible.document).toMatchObject({
    diagnostics: [
      {
        code: "printing_match_contradictory",
        locator: "/official/locator-binding/stable",
        matched_printing_ids: [printingId],
        detail: expect.stringContaining("retained locator contradicts"),
      },
    ],
  });
  const retainedBinding = await reconciliationQueries
    .readReconciledPrintingLocatorsPrintingIdCurrent(testEnv.CATALOGUE_DB)
    .first<{
      printing_id: string;
      current: number;
      last_missing_revision_id: string;
    }>();
  expect(retainedBinding).toEqual({
    printing_id: printingId,
    current: 0,
    last_missing_revision_id: missingAgainRevision,
  });
  expect(await exportComponentRecords(missingAgainRevision, "printings")).toContainEqual(
    expect.objectContaining({
      id: printingId,
    }),
  );
}, 30_000);

test("locator variant evolution preserves effective-dated suffix history across disappearance and reactivation", async () => {
  const firstRun = await collect("/reconciliation/locator-variant-v1", "locator-variant-v1");
  const first = await reconcile(firstRun.id);
  const printingId = requiredString(requiredFirst(first.document, "printings"), "id");
  const firstRevision = requiredString((await approve(first.document)).document, "resulting_revision_id");
  const secondRun = await collect("/reconciliation/locator-variant-v2", "locator-variant-v2");
  const second = await reconcile(secondRun.id);
  expect(requiredFirst(second.document, "printings")).toMatchObject({
    id: printingId,
  });
  const secondRevision = requiredString((await approve(second.document)).document, "resulting_revision_id");
  const evolved = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(evolved.document.locators).toMatchObject({
    current: [
      expect.objectContaining({
        locator: "/official/locator-variant/stable",
        variant_key: "suffix-b",
        first_revision_id: secondRevision,
        current: true,
      }),
    ],
    historical: [
      expect.objectContaining({
        locator: "/official/locator-variant/stable",
        variant_key: "suffix-a",
        first_revision_id: firstRevision,
        last_observed_revision_id: firstRevision,
        current: false,
        last_missing_revision_id: secondRevision,
      }),
    ],
  });
  const missingRun = await collect("/reconciliation/complete-empty-lineage", "locator-variant-missing");
  const missing = await reconcile(missingRun.id);
  const missingRevision = requiredString((await approve(missing.document)).document, "resulting_revision_id");
  const reactivatedRun = await collect("/reconciliation/locator-variant-v1", "locator-variant-reactivate-v1");
  const reactivated = await reconcile(reactivatedRun.id);
  const reactivatedRevision = requiredString((await approve(reactivated.document)).document, "resulting_revision_id");
  const lifecycle = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(lifecycle.document.locators).toMatchObject({
    current: [
      expect.objectContaining({
        variant_key: "suffix-a",
        first_revision_id: firstRevision,
        last_observed_revision_id: reactivatedRevision,
        last_missing_revision_id: null,
      }),
    ],
    historical: [
      expect.objectContaining({
        variant_key: "suffix-b",
        first_revision_id: secondRevision,
        last_observed_revision_id: secondRevision,
        current: false,
        last_missing_revision_id: missingRevision,
      }),
    ],
  });
  expect(await exportComponentRecords(reactivatedRevision, "printings")).toContainEqual(
    expect.objectContaining({
      id: printingId,
    }),
  );
}, 20_000);

test("Card search keeps exactly the current and two preceding distinct Catalogue Revisions hot", async () => {
  const status = await get("/v1/status");
  const baselineRevision = requiredString(
    requiredRecord(status.document.safe_state, "safe_state"),
    "current_revision_id",
  );
  const revisions: string[] = [];
  let retainedDocumentCount: number | null = null;
  for (const [index, scenario] of [
    "query-hot-window-1",
    "query-hot-window-2",
    "query-hot-window-3",
    "query-hot-window-4",
  ].entries()) {
    const run = await collect(`/reconciliation/${scenario}`, `query-hot-window-${index + 1}-${scenario}`);
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const revisionId = requiredString((await approve(reconciled.document)).document, "resulting_revision_id");
    expect(revisions).not.toContain(revisionId);
    revisions.push(revisionId);
    if (retainedDocumentCount === null) {
      retainedDocumentCount =
        (
          await publishedCatalogueQueries
            .countRevisionCardQueryDocumentsCount(testEnv.CATALOGUE_DB)
            .bind(revisionId)
            .first<{ count: number }>()
        )?.count ?? null;
    }
  }
  const [first, second, third, current] = revisions as [string, string, string, string];
  expect(retainedDocumentCount).not.toBeNull();
  const chain = await publishedCatalogueQueries
    .readCatalogueRevisionsIdExpectedPreviousRevisionId(testEnv.CATALOGUE_DB)
    .bind(first, second, third, current)
    .all<{
      id: string;
      expected_previous_revision_id: string;
      current_revision_id: string;
    }>();
  expect(chain.results).toHaveLength(4);
  expect(new Map(chain.results.map((revision) => [revision.id, revision.expected_previous_revision_id]))).toEqual(
    new Map([
      [first, baselineRevision],
      [second, first],
      [third, second],
      [current, third],
    ]),
  );
  expect(new Set(chain.results.map(({ current_revision_id }) => current_revision_id))).toEqual(new Set([current]));

  const queryStates = await publishedCatalogueQueries
    .countCatalogueQueryRevisionsDocumentCountForCardSearchKeepsExactlyCurrentTwoPrecedingDistinctCatalogue(
      testEnv.CATALOGUE_DB,
    )
    .bind(first, second, third, current)
    .all<{
      catalogue_revision_id: string;
      state: string;
      document_count: number;
    }>();
  expect(queryStates.results).toHaveLength(4);
  const queryStateByRevision = new Map(
    queryStates.results.map((row) => [
      row.catalogue_revision_id,
      { state: row.state, document_count: row.document_count },
    ]),
  );
  expect(queryStateByRevision.get(first)).toEqual({
    state: "archived",
    document_count: 0,
  });
  for (const retainedRevision of [second, third, current]) {
    expect(queryStateByRevision.get(retainedRevision)).toEqual({
      state: "available",
      document_count: retainedDocumentCount,
    });
  }
}, 30_000);
