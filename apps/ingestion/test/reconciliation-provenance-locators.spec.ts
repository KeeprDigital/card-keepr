import { nativePrintingHistory } from "../../../src/catalogue/reconciliation/native-printing-history";
import { beforeEach, describe, expect, test } from "vitest";
import { reconciliationCheckpoint } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { catalogueStore } from "../../../src/catalogue/shared";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { nativeCandidateRecords, waitForNativeCandidates } from "./native-candidate-helpers";
import { readNativeCards } from "./native-no-change-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { currentGameMembers } from "./query-helpers/atomic-publication";
import * as catalogueExportQueries from "./query-helpers/catalogue-export";
import { nativeNoChangeState } from "./query-helpers/native-no-change";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import {
  collect,
  exportComponentRecords,
  exportManifest,
  get,
  installReconciliationSuite,
  post,
  reconcile as reconcileLegacy,
  requiredFirst,
  requiredRecord,
  requiredString,
  testEnv,
  waitForRunState,
} from "./reconciliation-helpers";

installReconciliationSuite({ directPreparation: true });

test("fresh native provenance retains the consumer revision and export for semantic no-change", async () => {
  const firstRun = await collect("/reconciliation/repeatable", "native-repeatable-first");
  const first = await prepareNativeCandidate(firstRun.id, "one-piece", "catrev_spine_000", "repeatable-first-prepare");
  const firstSemantic = await reconciliationCheckpoint<{ digest: string }>(
    catalogueStore(testEnv.CATALOGUE_DB),
    requiredString(first, "id"),
    "canonical_digest:catalogue",
  );
  expect(firstSemantic?.value.digest).toMatch(/^[a-f0-9]{64}$/);
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
  const secondSemantic = await reconciliationCheckpoint<{ digest: string }>(
    catalogueStore(testEnv.CATALOGUE_DB),
    requiredString(second, "id"),
    "canonical_digest:catalogue",
  );
  expect(secondSemantic?.value.digest).toBe(firstSemantic?.value.digest);
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
  const base = await prepareEvidence(baseRun.id);
  const printingId = requiredString(requiredFirst(base.records, "printings"), "id");
  const basePublished = await publishEvidence(base);
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
  const locator = await prepareEvidence(locatorRun.id);
  expect(locator.header.manifest_digest).not.toBe(base.header.manifest_digest);
  expect(await semanticDigest(locator.header)).toBe(await semanticDigest(base.header));
  const locatorPublished = await publishEvidence(locator);
  expect(locatorPublished.document).toMatchObject({
    state: "published",
    resulting_revision_id: revisionId,
  });
  const retainedLocator = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(requiredRecord(retainedLocator.document.locators, "locators").current).toContainEqual(
    expect.objectContaining({
      locator: "/official/evidence/relocated",
      last_observed_revision_id: revisionId,
      current: true,
    }),
  );
  expect(JSON.stringify(locator.records)).toContain("srcobs_");

  const sourceBucketRun = await collect(
    "/reconciliation/semantic-evidence-source-bucket",
    "reconcile-semantic-evidence-source-bucket",
  );
  const sourceBucket = await prepareEvidence(sourceBucketRun.id);
  expect(sourceBucket.header.manifest_digest).not.toBe(locator.header.manifest_digest);
  expect(await semanticDigest(sourceBucket.header)).toBe(await semanticDigest(base.header));
  const sourceBucketPublished = await publishEvidence(sourceBucket);
  expect(sourceBucketPublished.document).toMatchObject({
    state: "published",
    resulting_revision_id: revisionId,
  });
  const retainedBucket = await nativePrintingHistory(catalogueStore(testEnv.CATALOGUE_DB), printingId);
  expect(retainedBucket?.memberships).toContainEqual(
    expect.objectContaining({
      relationship_kind: "source_bucket",
      relationship_value: "secondary-card-list",
      source_observation_id: expect.stringMatching(/^srcobs_/),
      last_observed_revision_id: revisionId,
      current: 1,
    }),
  );
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
  const forward = await prepareNativeCandidate(forwardRun.id, "one-piece", "catrev_spine_000", "forward-prepare");
  const published = await approveNativeCandidate(forward, "forward-publish");
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const relationships = await exportComponentRecords(revisionId, "relationships");

  const reverseRun = await collect("/reconciliation/deterministic-reverse", "reconcile-deterministic-reverse");
  const reverse = await prepareNativeCandidate(reverseRun.id, "one-piece", revisionId, "reverse-prepare");
  expect(reverse.manifest_digest).not.toBe(forward.manifest_digest);
  const repeated = await approveNativeCandidate(reverse, "reverse-publish");
  expect(repeated.document).toMatchObject({
    resulting_revision_id: revisionId,
  });
  expect(await exportComponentRecords(revisionId, "relationships")).toEqual(relationships);
});

test("a known locator with contradictory retained material evidence fails the native candidate before publication", async () => {
  const establishedRun = await collect("/reconciliation/conflict-base", "reconcile-conflict-base");
  const established = await prepareNativeCandidate(
    establishedRun.id,
    "one-piece",
    "catrev_spine_000",
    "conflict-base-prepare",
  );
  const published = await approveNativeCandidate(established, "conflict-base-publish");
  const revisionId = requiredString(published.document, "resulting_revision_id");

  const conflictRun = await collect("/reconciliation/conflict-changed", "reconcile-conflict-changed");
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: conflictRun.id,
    supported_game: "one-piece",
    expected_game_revision_id: revisionId,
    idempotency_key: "conflict-changed-prepare",
  });
  expect(created.response.status).toBe(201);
  const [conflict] = await waitForNativeCandidates(conflictRun.id, 1, 15_000, { "one-piece": "failed" });
  expect(conflict?.outcome).toMatchObject({ state: "failed" });
  // The operation envelope is a bounded code/detail summary. The exact
  // retained diagnostic, including its locator, belongs to the candidate pages.
  const diagnostics = await nativeCandidateRecords(requiredString(conflict ?? {}, "id"));
  expect([...(diagnostics.warnings ?? []), ...(diagnostics.shared_warnings ?? [])]).toMatchObject([
    { code: "printing_match_contradictory", locator: "/official/conflict" },
  ]);
});

test("same-lineage authoritative Card evolution updates canonical facts while preserving identity", async () => {
  const firstRun = await collect("/reconciliation/canonical-base", "reconcile-canonical-base");
  const first = await prepareEvidence(firstRun.id);
  const cardId = requiredString(requiredFirst(first.records, "cards"), "id");
  await publishEvidence(first);

  const changedRun = await collect("/reconciliation/canonical-name-conflict", "reconcile-canonical-name-conflict");
  const changed = await prepareEvidence(changedRun.id);
  expect(changed.header.state).toBe("sealed");
  expect(requiredFirst(changed.records, "cards")).toMatchObject({
    id: cardId,
    name: "Unsupported replacement name",
  });
  await publishEvidence(changed);
  expect(requiredFirst(first.records, "cards").name).not.toBe(requiredFirst(changed.records, "cards").name);
  expect(requiredFirst(await nativeCandidateRecords(String(first.header.id)), "cards")).toEqual(
    requiredFirst(first.records, "cards"),
  );
  const current = await readNativeCards(
    requiredString((await get("/v1/status")).document.safe_state as Record<string, unknown>, "current_revision_id"),
  );
  expect(await current.json()).toMatchObject({
    data: expect.arrayContaining([expect.objectContaining({ id: cardId, name: "Unsupported replacement name" })]),
  });
});

test("sequential selected-game publications retain the complete current catalogue across D1 and export", async () => {
  const onePieceRun = await collect("/reconciliation/base", "reconcile-union-one-piece");
  const onePiece = await prepareEvidence(onePieceRun.id);
  const onePieceCard = requiredFirst(onePiece.records, "cards");
  const onePiecePrinting = requiredFirst(onePiece.records, "printings");
  const onePiecePublished = await publishEvidence(onePiece);
  expect(onePiecePublished.response.status).toBe(200);
  const onePieceRevision = requiredString(onePiecePublished.document, "resulting_revision_id");
  const _firstManifest = await exportManifest(onePieceRevision);

  const fusionRun = await collect("/reconciliation/union-fusion-world", "reconcile-union-fusion-world", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const fusion = await prepareEvidence(fusionRun.id, "fusion-world");
  expect(fusion.header.state).toBe("sealed");
  for (const kind of ["cards", "printings"])
    expect(
      (fusion.records.inspection ?? []).filter((entry) => entry.entity_class === kind && entry.change === "added"),
    ).toHaveLength(1);
  const published = await publishEvidence(fusion);
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

  const members = await currentGameMembers(testEnv.CATALOGUE_DB);
  expect(members.results.map((member) => member.supported_game).sort()).toEqual(["fusion-world", "one-piece"]);
  const cardIds = members.results.flatMap((member) => member.card_ids.split(","));
  expect(cardIds).toContain(requiredString(onePieceCard, "id"));
  expect(await exportComponentRecords(revisionId, "cards")).toHaveLength(cardIds.length);
  expect(await exportComponentRecords(revisionId, "printings")).toContainEqual(
    expect.objectContaining({ id: onePiecePrinting.id }),
  );
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
  const refresh = await prepareEvidence(refreshRun.id);
  expect(refresh.header.manifest_digest).not.toBe(onePiece.header.manifest_digest);
  expect(await semanticDigest(refresh.header)).toBe(await semanticDigest(onePiece.header));
  const refreshed = await publishEvidence(refresh);
  expect(refreshed.document).toMatchObject({
    state: "published",
    resulting_revision_id: revisionId,
  });
  expect((await nativeNoChangeState(testEnv.CATALOGUE_DB))?.accepted_candidate).toBe(refresh.header.id);
  const refreshedHistory = await get(`/v1/reconciliation/printings/${onePiecePrinting.id}`);
  expect(refreshedHistory.response.status).toBe(200);
  expect(JSON.stringify(refreshedHistory.document.relationship_evidence)).toContain("srcobs_");
  expect(refreshedHistory.document.locators).toMatchObject({
    current: expect.arrayContaining([expect.objectContaining({ last_observed_revision_id: revisionId })]),
  });
  expect(await exportComponentRecords(revisionId, "cards")).toHaveLength(cardIds.length);
});

test("candidate inspection reports stable reconciliation matches rather than every entity as added", async () => {
  const firstRun = await collect("/reconciliation/base", "reconcile-inspection-base");
  const first = await prepareNativeCandidate(firstRun.id, "one-piece", "catrev_spine_000", "inspection-first-prepare");
  const firstRecords = await nativeCandidateRecords(requiredString(first, "id"));
  const firstCard = requiredFirst(firstRecords, "cards");
  const firstPrinting = requiredFirst(firstRecords, "printings");
  const published = await approveNativeCandidate(first, "inspection-first-publish");
  const revisionId = requiredString(published.document, "resulting_revision_id");

  const nextRun = await collect("/reconciliation/new-locator", "reconcile-inspection-new-locator");
  const next = await prepareNativeCandidate(nextRun.id, "one-piece", revisionId, "inspection-next-prepare");
  const inspected = await nativeCandidateRecords(requiredString(next, "id"));
  expect(inspected.warnings ?? []).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "relationship_not_observed",
        printing_id: requiredString(firstPrinting, "id"),
      }),
    ]),
  );
  for (const [kind, entity] of [
    ["cards", firstCard],
    ["printings", firstPrinting],
  ] as const) {
    const entries = (inspected.inspection ?? []).filter(({ entity_class }) => entity_class === kind);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entity_id: entity.id,
      before: { id: entity.id },
      after: { id: entity.id },
    });
    expect(["carry_forward", "evidence_only"], JSON.stringify(entries[0])).toContain(entries[0]!.change);
  }
  expect(inspected.warnings ?? []).not.toContainEqual(
    expect.objectContaining({
      code: "record_not_observed",
      card_id: firstCard.id,
    }),
  );
  const abandoned = await post(`/v1/game-candidates/${next.id}/abandon`, {
    generation: next.generation,
    idempotency_key: "abandon-inspected-candidate",
  });
  expect(abandoned.response.status).toBe(200);
  expect(abandoned.document.state).toBe("abandoned");
});

test("generic retry rejects an evidence-backed terminal run so reconciliation provenance cannot be reset", async () => {
  const run = await collect("/reconciliation/base", "reconcile-generic-retry");
  const reconciled = await reconcileLegacy(run.id);
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
  const interveningRun = await collect("/reconciliation/repeatable", "intervening-current-revision");
  const intervening = await prepareEvidence(interveningRun.id);
  const interveningPublished = await publishEvidence(intervening);
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
  const retryCandidate = await reconcileLegacy(retryId);
  const rejected = await post(`/v1/ingestion-runs/${retryId}/rejection`, {
    candidate_digest: requiredString(retryCandidate.document, "candidate_digest"),
    idempotency_key: "reject-linked-retry-after-verification",
  });
  expect(rejected.response.status).toBe(200);
}, 30_000);

test("historical locator bindings reactivate only for the same Printing and expose lifecycle evidence", async () => {
  const baseRun = await collect("/reconciliation/locator-binding-base", "locator-binding-base");
  const base = await prepareEvidence(baseRun.id);
  const printingId = requiredString(requiredFirst(base.records, "printings"), "id");
  const basePublished = await publishEvidence(base);
  const firstRevision = requiredString(basePublished.document, "resulting_revision_id");

  const missingRun = await collect("/reconciliation/complete-empty-lineage", "locator-binding-missing-first");
  const missing = await prepareEvidence(missingRun.id);
  const missingPublished = await publishEvidence(missing);
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
  const compatible = await prepareEvidence(compatibleRun.id);
  expect(requiredFirst(compatible.records, "printings")).toMatchObject({
    id: printingId,
  });
  const compatiblePublished = await publishEvidence(compatible);
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
  const missingAgain = await prepareEvidence(missingAgainRun.id);
  const missingAgainPublished = await publishEvidence(missingAgain);
  const missingAgainRevision = requiredString(missingAgainPublished.document, "resulting_revision_id");
  const incompatibleRun = await collect(
    "/reconciliation/locator-binding-incompatible",
    "locator-binding-incompatible-return",
  );
  const incompatible = await prepareEvidence(incompatibleRun.id, "one-piece", "failed");
  expect(incompatible.header.state).toBe("failed");
  expect([...(incompatible.records.warnings ?? []), ...(incompatible.records.shared_warnings ?? [])]).toContainEqual(
    expect.objectContaining({
      code: "printing_match_contradictory",
      locator: "/official/locator-binding/stable",
      matched_printing_ids: [printingId],
      detail: expect.stringContaining("retained locator contradicts"),
    }),
  );
  const retainedBinding = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(retainedBinding.document.locators).toMatchObject({
    current: [],
    historical: expect.arrayContaining([
      expect.objectContaining({ current: false, last_missing_revision_id: missingAgainRevision }),
    ]),
  });
  expect(await exportComponentRecords(missingAgainRevision, "printings")).toContainEqual(
    expect.objectContaining({
      id: printingId,
    }),
  );
}, 30_000);

describe("locator variant evolution", () => {
  let printingId: string;
  let firstRevision: string;
  let secondRevision: string;
  beforeEach(async () => {
    const firstRun = await collect("/reconciliation/locator-variant-v1", "locator-variant-v1");
    const first = await prepareEvidence(firstRun.id);
    printingId = requiredString(requiredFirst(first.records, "printings"), "id");
    firstRevision = requiredString((await publishEvidence(first)).document, "resulting_revision_id");
    const secondRun = await collect("/reconciliation/locator-variant-v2", "locator-variant-v2");
    const second = await prepareEvidence(secondRun.id);
    expect(requiredFirst(second.records, "printings")).toMatchObject({
      id: printingId,
    });
    secondRevision = requiredString((await publishEvidence(second)).document, "resulting_revision_id");
  });
  test("preserves effective-dated suffix history across disappearance and reactivation", async () => {
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
    const missing = await prepareEvidence(missingRun.id);
    const missingRevision = requiredString((await publishEvidence(missing)).document, "resulting_revision_id");
    const reactivatedRun = await collect("/reconciliation/locator-variant-v1", "locator-variant-reactivate-v1");
    const reactivated = await prepareEvidence(reactivatedRun.id);
    const reactivatedRevision = requiredString((await publishEvidence(reactivated)).document, "resulting_revision_id");
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
});

test("Card search keeps exactly the current and two preceding distinct Catalogue Revisions hot", async () => {
  const status = await get("/v1/status");
  const baselineRevision = requiredString(
    requiredRecord(status.document.safe_state, "safe_state"),
    "current_revision_id",
  );
  const revisions: string[] = [];
  for (const [index, scenario] of [
    "query-hot-window-1",
    "query-hot-window-2",
    "query-hot-window-3",
    "query-hot-window-4",
  ].entries()) {
    const run = await collect(`/reconciliation/${scenario}`, `query-hot-window-${index + 1}-${scenario}`);
    const reconciled = await prepareEvidence(run.id);
    expect(reconciled.header.state).toBe("sealed");
    const revisionId = requiredString((await publishEvidence(reconciled)).document, "resulting_revision_id");
    expect(revisions).not.toContain(revisionId);
    revisions.push(revisionId);
  }
  const [first, second, third, current] = revisions as [string, string, string, string];
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

  const archived = await readNativeCards(first);
  expect(archived.status).toBe(503);
  expect(await archived.json()).toMatchObject({ code: "catalogue_query_unavailable" });
  for (const retainedRevision of [second, third, current]) {
    const response = await readNativeCards(retainedRevision);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: expect.any(Array) });
  }
}, 30_000);

async function prepareEvidence(runId: string, game = "one-piece", state = "sealed") {
  const members = await currentGameMembers(testEnv.CATALOGUE_DB);
  const predecessor =
    members.results.find((member) => member.supported_game === game)?.game_revision_id ?? "catrev_spine_000";
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: runId,
    supported_game: game,
    expected_game_revision_id: predecessor,
    idempotency_key: `provenance-prepare-${runId}`,
  });
  expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  const [header] = await waitForNativeCandidates(runId, 1, 15000, { [game]: state });
  return { header: header!, records: await nativeCandidateRecords(String(header!.id)) };
}
async function publishEvidence(prepared: Awaited<ReturnType<typeof prepareEvidence>>) {
  const published = await approveNativeCandidate(prepared.header, `provenance-publish-${prepared.header.id}`);
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  return published;
}
async function semanticDigest(header: Record<string, unknown>) {
  const receipt = await reconciliationCheckpoint<{ digest: string }>(
    catalogueStore(testEnv.CATALOGUE_DB),
    String(header.id),
    "canonical_digest:catalogue",
  );
  expect(receipt?.value.digest).toMatch(/^[a-f0-9]{64}$/);
  return receipt!.value.digest;
}
