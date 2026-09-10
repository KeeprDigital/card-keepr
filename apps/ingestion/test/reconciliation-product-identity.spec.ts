import { expect, test } from "vitest";
import { compositionEntityResponse } from "../../../src/catalogue/read";
import { catalogueStore } from "../../../src/catalogue/shared";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { nativeCandidateRecords, waitForNativeCandidates } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { mutateNativeProductOfficialCode, nativeProductIdentity } from "./query-helpers/native-product-history";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import {
  collect,
  collectRequests,
  exportComponentRecords,
  exportManifest,
  get,
  installReconciliationSuite,
  post,
  postFixtureEvidence,
  requiredFirst,
  requiredString,
  testEnv,
  waitForRunState,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("accepted typed Product relationships persist without code/name namespace collisions", async () => {
  const run = await collect("/reconciliation/product-typed-relationships", "product-typed-relationships");
  const reconciled = await prepareProductCandidate(run.id, "catrev_spine_000", "one-piece");
  const revisionId = requiredString(
    (await approveNativeCandidate(reconciled.header, `publish-${reconciled.header.id}`)).document,
    "resulting_revision_id",
  );
  const [products, contexts, relationships, cards] = await Promise.all([
    exportComponentRecords(revisionId, "products"),
    exportComponentRecords(revisionId, "distribution-contexts"),
    exportComponentRecords(revisionId, "relationships"),
    exportComponentRecords(revisionId, "cards"),
  ]);
  const coded = products.find((entry) => entry.official_code === "CODE-X");
  const named = products.find((entry) => entry.official_code === null && entry.name === "CODE-X");
  expect(coded?.id).toEqual(expect.any(String));
  expect(named?.id).toEqual(expect.any(String));
  expect(coded?.id).not.toBe(named?.id);
  const context = contexts.find((entry) => entry.label === "Typed relationship context");
  expect(context).toMatchObject({ product_id: coded?.id });
  expect(relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "printing-product",
        to: { type: "product", id: coded?.id },
      }),
      expect.objectContaining({
        kind: "printing-distribution-context",
        to: { type: "distribution_context", id: context?.id },
      }),
      expect.objectContaining({
        kind: "distribution-context-product",
        from: { type: "distribution_context", id: context?.id },
        to: { type: "product", id: coded?.id },
      }),
      expect.objectContaining({
        kind: "product-card",
        from: { type: "product", id: named?.id },
        to: { type: "card", id: expect.any(String) },
      }),
    ]),
  );
  const productCard = relationships.find(
    (relationship) =>
      relationship.kind === "product-card" && (relationship.from as Record<string, unknown>).id === named?.id,
  );
  expect(cards.some((entry) => entry.id === (productCard?.to as Record<string, unknown> | undefined)?.id)).toBe(true);
  expect(JSON.stringify({ products, contexts, relationships })).not.toContain("typed-source-bucket");
});

test("standalone Product lifecycle survives rename, disappearance, and explicit withdrawal", async () => {
  const firstRun = await collect("/reconciliation/product-standalone-v1", "product-standalone-v1");
  const firstCandidate = await prepareProductCandidate(firstRun.id, "catrev_spine_000", "one-piece");
  const firstRevision = requiredString(
    (await approveNativeCandidate(firstCandidate.header, `publish-${firstCandidate.header.id}`)).document,
    "resulting_revision_id",
  );

  const secondRun = await collect("/reconciliation/product-standalone-v2", "product-standalone-v2");
  const secondCandidate = await prepareProductCandidate(secondRun.id, firstRevision, "one-piece");
  const secondRevision = requiredString(
    (await approveNativeCandidate(secondCandidate.header, `publish-${secondCandidate.header.id}`)).document,
    "resulting_revision_id",
  );
  const secondProduct = (await exportComponentRecords(secondRevision, "products")).find(
    (entry) => entry.official_code === "ST-STANDALONE",
  );
  expect(secondProduct).toMatchObject({
    name: "Renamed Standalone Product",
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: secondRevision,
      withdrawn: false,
    },
  });

  const missingRun = await collect("/reconciliation/product-standalone-missing", "product-standalone-missing");
  const missingCandidate = await prepareProductCandidate(missingRun.id, secondRevision, "one-piece");
  expect(Array.isArray(missingCandidate.records.warnings) ? missingCandidate.records.warnings : []).toContainEqual(
    expect.objectContaining({
      code: "product_not_observed",
      product_id: secondProduct?.id,
    }),
  );
  const missingPublication = await approveNativeCandidate(
    missingCandidate.header,
    `publish-${missingCandidate.header.id}`,
  );
  expect(missingPublication.document).toMatchObject({
    resulting_revision_id: secondRevision,
  });
  const missingRevision = requiredString(missingPublication.document, "resulting_revision_id");
  const carried = (await exportComponentRecords(missingRevision, "products")).find(
    (entry) => entry.id === secondProduct?.id,
  );
  expect(carried).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: secondRevision,
      withdrawn: false,
    },
  });

  const withdrawnRun = await collect("/reconciliation/product-standalone-withdrawn", "product-standalone-withdrawn");
  const withdrawnCandidate = await prepareProductCandidate(withdrawnRun.id, missingRevision, "one-piece");
  const withdrawnRevision = requiredString(
    (await approveNativeCandidate(withdrawnCandidate.header, `publish-${withdrawnCandidate.header.id}`)).document,
    "resulting_revision_id",
  );
  const withdrawn = (await exportComponentRecords(withdrawnRevision, "products")).find(
    (entry) => entry.id === secondProduct?.id,
  );
  expect(withdrawn).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: withdrawnRevision,
      withdrawn: true,
      withdrawal: {
        revision_id: withdrawnRevision,
      },
    },
  });
}, 45_000);

test.each([
  {
    label: "inferred membership to typed evidence",
    first: "product-identity-inferred",
    second: "product-identity-typed",
    firstMatch: (product: Record<string, unknown>) => product.official_code === "IDENTITY-INFERRED",
    secondCode: "IDENTITY-INFERRED",
  },
  {
    label: "name-only evidence to official code",
    first: "product-identity-name",
    second: "product-identity-coded",
    firstMatch: (product: Record<string, unknown>) =>
      product.official_code === null && product.name === "Name-to-code Identity Product",
    secondCode: "IDENTITY-NAME-CODE",
  },
  {
    label: "official Product rename",
    first: "product-identity-rename-v1",
    second: "product-identity-rename-v2",
    firstMatch: (product: Record<string, unknown>) => product.official_code === "IDENTITY-RENAME",
    secondCode: "IDENTITY-RENAME",
  },
])(
  "Product identity and lifecycle survive $label",
  async ({ first, second, firstMatch, secondCode }) => {
    const firstRun = await collect(`/reconciliation/${first}`, `identity-${first}`);
    const firstCandidate = await prepareProductCandidate(firstRun.id, "catrev_spine_000", "one-piece");
    const firstRevision = requiredString(
      (await approveNativeCandidate(firstCandidate.header, `publish-${firstCandidate.header.id}`)).document,
      "resulting_revision_id",
    );
    const firstProduct = (await exportComponentRecords(firstRevision, "products")).find(firstMatch);
    expect(firstProduct).toBeDefined();
    const firstId = requiredString(firstProduct ?? {}, "id");

    const secondRun = await collect(`/reconciliation/${second}`, `identity-${second}`);
    const secondCandidate = await prepareProductCandidate(secondRun.id, firstRevision, "one-piece");
    const secondRevision = requiredString(
      (await approveNativeCandidate(secondCandidate.header, `publish-${secondCandidate.header.id}`)).document,
      "resulting_revision_id",
    );
    const secondProduct = (await exportComponentRecords(secondRevision, "products")).find(
      ({ official_code }) => official_code === secondCode,
    );
    expect(secondProduct).toMatchObject({
      id: firstId,
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: secondRevision,
        withdrawn: false,
      },
    });
    const persistedIdentity = await nativeProductIdentity(testEnv.CATALOGUE_DB)
      .bind(requiredString(secondCandidate.header, "id"), firstId)
      .first<{ id: string; official_code: string | null }>();
    expect(persistedIdentity).toEqual({
      id: firstId,
      official_code: secondCode,
    });
    await expect(
      mutateNativeProductOfficialCode(testEnv.CATALOGUE_DB)
        .bind(requiredString(secondCandidate.header, "id"), firstId)
        .run(),
    ).rejects.toThrow(/publication_read_immutable/u);
    const productResponse = await compositionEntityResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      new Request(`https://card-keepr.invalid/v1/products/${firstId}`),
      { origin: "https://card-keepr.invalid", basePath: "" },
      "products",
      firstId,
    );
    if (!productResponse) throw new Error("Native Product response missing.");
    expect(productResponse.status).toBe(200);
    expect(await productResponse.json()).toMatchObject({
      data: { id: firstId, official_code: secondCode },
      meta: { catalogue_revision_id: secondRevision },
    });
    const productRelationships = await exportComponentRecords(secondRevision, "relationships");
    expect(
      productRelationships.some((relationship) =>
        [relationship.from, relationship.to].some(
          (endpoint) =>
            typeof endpoint === "object" && endpoint !== null && (endpoint as Record<string, unknown>).id === firstId,
        ),
      ),
    ).toBe(true);
  },
  90_000,
);

test("same-name Products with different official codes remain distinct across revisions", async () => {
  const firstRun = await collect("/reconciliation/product-identity-distinct-code-a", "identity-distinct-code-a");
  const firstCandidate = await prepareProductCandidate(firstRun.id, "catrev_spine_000", "one-piece");
  const firstRevision = requiredString(
    (await approveNativeCandidate(firstCandidate.header, `publish-${firstCandidate.header.id}`)).document,
    "resulting_revision_id",
  );
  const firstProducts = await exportComponentRecords(firstRevision, "products");
  const firstProduct = firstProducts.find(({ official_code }) => official_code === "IDENTITY-DISTINCT-A");
  expect(firstProduct).toBeDefined();
  const firstProductId = requiredString(firstProduct ?? {}, "id");
  const firstRelationships = await exportComponentRecords(firstRevision, "relationships");
  const firstRelationship = firstRelationships.find(
    ({ kind, from }) =>
      kind === "product-card" &&
      typeof from === "object" &&
      from !== null &&
      (from as Record<string, unknown>).id === firstProductId,
  );
  expect(firstRelationship).toBeDefined();
  const firstRelationshipId = requiredString(firstRelationship ?? {}, "id");

  const secondRun = await collect("/reconciliation/product-identity-distinct-code-b", "identity-distinct-code-b");
  const secondCandidate = await prepareProductCandidate(secondRun.id, firstRevision, "one-piece");
  const secondRevision = requiredString(
    (await approveNativeCandidate(secondCandidate.header, `publish-${secondCandidate.header.id}`)).document,
    "resulting_revision_id",
  );
  const secondProducts = await exportComponentRecords(secondRevision, "products");
  const carriedFirst = secondProducts.find(({ official_code }) => official_code === "IDENTITY-DISTINCT-A");
  const distinctSecond = secondProducts.find(({ official_code }) => official_code === "IDENTITY-DISTINCT-B");
  expect(carriedFirst).toMatchObject({
    id: firstProductId,
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: firstRevision,
      withdrawn: false,
    },
  });
  expect(distinctSecond).toMatchObject({
    lifecycle: {
      first_revision_id: secondRevision,
      last_observed_revision_id: secondRevision,
      withdrawn: false,
    },
  });
  const secondProductId = requiredString(distinctSecond ?? {}, "id");
  expect(secondProductId).not.toBe(firstProductId);

  const secondRelationships = await exportComponentRecords(secondRevision, "relationships");
  expect(secondRelationships.find(({ id }) => id === firstRelationshipId)).toMatchObject({
    from: { type: "product", id: firstProductId },
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: firstRevision,
      current: false,
      last_missing_revision_id: secondRevision,
    },
  });
  expect(
    secondRelationships.find(
      ({ kind, from }) =>
        kind === "product-card" &&
        typeof from === "object" &&
        from !== null &&
        (from as Record<string, unknown>).id === secondProductId,
    ),
  ).toMatchObject({
    lifecycle: {
      first_revision_id: secondRevision,
      last_observed_revision_id: secondRevision,
      current: true,
      last_missing_revision_id: null,
    },
  });
}, 90_000);

test("a name-only Product matching multiple published Products fails closed without publication", async () => {
  let predecessor = "catrev_spine_000";
  for (const scenario of ["product-identity-distinct-code-a", "product-identity-distinct-code-b"]) {
    const run = await collect(`/reconciliation/${scenario}`, `identity-ambiguous-prior-${scenario}`);
    const candidate = await prepareProductCandidate(run.id, predecessor, "one-piece");
    const publication = await approveNativeCandidate(candidate.header, `publish-${candidate.header.id}`);
    predecessor = requiredString(publication.document, "resulting_revision_id");
  }
  const currentBefore = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<{ current_revision_id: string }>();

  const ambiguous = await collect("/reconciliation/product-identity-ambiguous-name", "identity-ambiguous-name-only");
  await expectProductEvidenceInvalid(ambiguous.id, predecessor, "matched multiple published Products");
  expect(
    await publishedCatalogueQueries
      .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
      .first<{ current_revision_id: string }>(),
  ).toEqual(currentBefore);
}, 90_000);

test("conflicting Distribution Context facts fail closed without publication", async () => {
  const currentBefore = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<{ current_revision_id: string }>();
  const run = await collectRequests(
    [
      { id: "context-a", scenario: "product-context-conflict-a" },
      { id: "context-b", scenario: "product-context-conflict-b" },
    ],
    "product-context-conflicting-facts",
  );

  await expectProductEvidenceInvalid(run.id, "catrev_spine_000", "Distribution Context facts conflict");
  expect(
    await publishedCatalogueQueries
      .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
      .first<{ current_revision_id: string }>(),
  ).toEqual(currentBefore);
});

test("identical Product facts are a semantic no-change while source freshness advances", async () => {
  const firstRun = await collect("/reconciliation/product-standalone-v1", "product-semantic-first");
  const firstCandidate = await prepareProductCandidate(firstRun.id, "catrev_spine_000", "one-piece");
  expect(firstCandidate.records.source_checks).toContainEqual(
    expect.objectContaining({
      game: "one-piece",
      area: "products-and-releases",
      checked_at: expect.any(String),
    }),
  );
  const firstPublished = await approveNativeCandidate(firstCandidate.header, `publish-${firstCandidate.header.id}`);
  const revisionId = requiredString(firstPublished.document, "resulting_revision_id");
  const firstFreshness = await productSourceFreshness();
  expect(firstFreshness).toMatchObject({ checked_at: expect.any(String), ingestion_run_id: firstRun.id });

  const secondRun = await collect("/reconciliation/product-standalone-v1", "product-semantic-second");
  const secondCandidate = await prepareProductCandidate(secondRun.id, revisionId, "one-piece");
  expect(secondCandidate.header.manifest_digest).not.toBe(firstCandidate.header.manifest_digest);
  expect(await productSourceFreshness()).toEqual(firstFreshness);
  const secondPublished = await approveNativeCandidate(secondCandidate.header, `publish-${secondCandidate.header.id}`);
  expect(secondPublished.document).toMatchObject({
    resulting_revision_id: revisionId,
  });
  const secondFreshness = await productSourceFreshness();
  expect(secondFreshness).toMatchObject({ checked_at: expect.any(String), ingestion_run_id: secondRun.id });
  expect(String(secondFreshness?.checked_at) > String(firstFreshness?.checked_at)).toBe(true);
}, 45_000);

test("Product observations and disappearance remain scoped to their Source Lineage", async () => {
  const asiaSource = {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@2",
  };
  const usSource = {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  };
  const asiaRun = await collect("/reconciliation/gundam-product-asia", "gundam-product-asia", asiaSource);
  const asiaCandidate = await prepareProductCandidate(asiaRun.id, "catrev_spine_000", "gundam");
  const asiaApproval = await approveNativeCandidate(asiaCandidate.header, `publish-${asiaCandidate.header.id}`);
  if (asiaApproval.response.status !== 200) {
    throw new Error(JSON.stringify(asiaApproval.document));
  }
  const asiaRevision = requiredString(asiaApproval.document, "resulting_revision_id");

  const usRun = await collect("/reconciliation/gundam-product-us", "gundam-product-us", usSource);
  const usCandidate = await prepareProductCandidate(usRun.id, asiaRevision, "gundam");
  const combined = usCandidate.records.products!.find((product) => product.official_code === "GD-CROSS")!;
  expect(combined.releases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ region: "EN-ASIA" }),
      expect.objectContaining({ region: "EN-US" }),
    ]),
  );
  expect(new Set((combined.releases as Record<string, unknown>[]).map(({ id }) => id)).size).toBe(2);
  expect(combined.included).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "gundam-en-asia" }),
      expect.objectContaining({ source: "gundam-en-us" }),
    ]),
  );
  expect(new Set(Object.values(combined.provenance as Record<string, string[]>).flat()).size).toBeGreaterThanOrEqual(2);
  const usRevision = requiredString(
    (await approveNativeCandidate(usCandidate.header, `publish-${usCandidate.header.id}`)).document,
    "resulting_revision_id",
  );

  const asiaMissingRun = await collect(
    "/reconciliation/gundam-product-asia-missing",
    "gundam-product-asia-missing",
    asiaSource,
  );
  const asiaMissing = await prepareProductCandidate(asiaMissingRun.id, usRevision, "gundam");
  const missingRevision = requiredString(
    (await approveNativeCandidate(asiaMissing.header, `publish-${asiaMissing.header.id}`)).document,
    "resulting_revision_id",
  );
  const carried = asiaMissing.records.products?.find(({ official_code }) => official_code === "GD-CROSS");
  expect(carried).toMatchObject({
    releases: [expect.objectContaining({ region: "EN-US" })],
    included: [expect.objectContaining({ source: "gundam-en-us" })],
  });
  expect(JSON.stringify(carried).includes("gundam-en-asia")).toBe(false);
  const exported = (await exportComponentRecords(missingRevision, "products")).find(
    (product) => product.official_code === "GD-CROSS",
  );
  expect(exported).toMatchObject({
    lifecycle: {
      first_revision_id: asiaRevision,
      last_observed_revision_id: usRevision,
      withdrawn: false,
    },
  });
  const priorReleases = (await exportComponentRecords(usRevision, "releases")).filter(
    (release) => release.product_id === exported?.id,
  );
  expect(priorReleases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ region: "EN-ASIA" }),
      expect.objectContaining({ region: "EN-US" }),
    ]),
  );
  const currentReleases = (await exportComponentRecords(missingRevision, "releases")).filter(
    (release) => release.product_id === exported?.id,
  );
  expect(currentReleases).toEqual([expect.objectContaining({ region: "EN-US" })]);
  expect(currentReleases[0]!.id).toBe(priorReleases.find((release) => release.region === "EN-US")!.id);
  expect(await exportComponentRecords(usRevision, "releases")).toEqual(expect.arrayContaining(priorReleases));
}, 45_000);

test("only an actual Product surface checks its Gundam Source Lineage", async () => {
  const usRun = await collect("/reconciliation/gundam-product-us", "gundam-product-us-prior-to-mixed-run", {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@2",
  });
  const usCandidate = await prepareProductCandidate(usRun.id, "catrev_spine_000", "gundam");
  const usPublication = await approveNativeCandidate(usCandidate.header, `publish-${usCandidate.header.id}`);
  const usRevision = requiredString(usPublication.document, "resulting_revision_id");

  const mixed = await postFixtureEvidence({
    idempotency_key: "gundam-mixed-product-and-card-surfaces",
    plans: [
      {
        supported_game: "gundam",
        source_lineage: "gundam-en-asia",
        adapter_version: "fixture-gundam-en-asia-json@2",
        requests: [
          {
            id: "asia-product",
            method: "GET",
            url: "https://official-source.invalid/reconciliation/" + "gundam-product-asia",
            headers: { accept: "application/json" },
          },
        ],
      },
      {
        supported_game: "gundam",
        source_lineage: "gundam-en-us",
        adapter_version: "fixture-gundam-en-us-json@2",
        requests: [
          {
            id: "us-card",
            method: "GET",
            url: "https://official-source.invalid/reconciliation/" + "gundam-cross-us",
            headers: { accept: "application/json" },
          },
        ],
      },
    ],
  });
  expect(mixed.response.status).toBe(201);
  const runId = requiredString(mixed.document, "id");
  await collectFixtureEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    testEnv.OFFICIAL_SOURCE_TRANSPORT,
    runId,
  );
  await waitForRunState(runId, "parsing");
  const candidate = await prepareProductCandidate(runId, usRevision, "gundam");
  const product = (candidate.records.products as Record<string, unknown>[]).find(
    ({ official_code }) => official_code === "GD-CROSS",
  );
  expect(product?.releases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ region: "EN-ASIA" }),
      expect.objectContaining({ region: "EN-US" }),
    ]),
  );
  expect(candidate.records.warnings ?? []).not.toContainEqual(
    expect.objectContaining({
      code: "product_not_observed",
      source_lineages: expect.arrayContaining(["gundam-en-us"]),
    }),
  );

  const published = await approveNativeCandidate(candidate.header, `publish-${candidate.header.id}`);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const exportedProduct = (await exportComponentRecords(revisionId, "products")).find(
    ({ official_code }) => official_code === "GD-CROSS",
  );
  expect(exportedProduct).toBeDefined();
  const exportedReleases = (await exportComponentRecords(revisionId, "releases")).filter(
    ({ product_id }) => product_id === exportedProduct?.id,
  );
  expect(exportedReleases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ region: "EN-ASIA" }),
      expect.objectContaining({ region: "EN-US" }),
    ]),
  );
}, 90_000);

test("Product freshness is emitted only for an actually checked Product surface", async () => {
  const checkedRun = await collect("/reconciliation/product-standalone-v1", "product-freshness-checked");
  const checkedCandidate = await prepareProductCandidate(checkedRun.id, "catrev_spine_000", "one-piece");
  expect(checkedCandidate.records.source_checks).toContainEqual(
    expect.objectContaining({
      game: "one-piece",
      area: "products-and-releases",
      checked_at: expect.any(String),
    }),
  );
  const checkedPublication = await approveNativeCandidate(
    checkedCandidate.header,
    `publish-${checkedCandidate.header.id}`,
  );
  expect(checkedPublication.response.status, JSON.stringify(checkedPublication.document)).toBe(200);
  const checkedRevision = requiredString(checkedPublication.document, "resulting_revision_id");
  const checkedSnapshot = await sourceEvidenceQueries
    .readSourceSnapshotsRetrievedAt(testEnv.CATALOGUE_DB)
    .bind(checkedRun.id)
    .first<{ retrieved_at: string }>();
  const checkedFreshness = await productSourceFreshness();
  expect(checkedFreshness).toMatchObject({
    checked_at: checkedSnapshot?.retrieved_at,
    ingestion_run_id: checkedRun.id,
  });

  const noCheckRun = await collect("/reconciliation/base", "product-freshness-no-check");
  const noCheckCandidate = await prepareProductCandidate(noCheckRun.id, checkedRevision, "one-piece");
  const noCheckRevision = requiredString(
    (await approveNativeCandidate(noCheckCandidate.header, `publish-${noCheckCandidate.header.id}`)).document,
    "resulting_revision_id",
  );
  expect(await productSourceFreshness()).toEqual(checkedFreshness);
  expect(await exportManifest(noCheckRevision)).not.toHaveProperty("source_freshness");
  expect(await exportComponentRecords(noCheckRevision, "products")).toContainEqual(
    expect.objectContaining({
      official_code: "ST-STANDALONE",
      lifecycle: expect.objectContaining({
        last_observed_revision_id: checkedRevision,
      }),
    }),
  );
}, 30_000);

test("a Digimon Release with unknown region remains schema-valid in the export", async () => {
  const run = await collect("/reconciliation/digimon-product-unknown-region", "digimon-product-unknown-region", {
    game: "digimon",
    lineage: "digimon-en",
    adapter: "fixture-digimon-json@2",
  });
  const candidate = await prepareProductCandidate(run.id, "catrev_spine_000", "digimon");
  const revisionId = requiredString(
    (await approveNativeCandidate(candidate.header, `publish-${candidate.header.id}`)).document,
    "resulting_revision_id",
  );
  expect(await exportComponentRecords(revisionId, "releases")).toContainEqual(
    expect.objectContaining({
      region: "unknown",
      date: { precision: "unknown", value: null },
    }),
  );
});

test("unknown Product relationship resolution fails closed", async () => {
  const run = await collect("/reconciliation/product-invalid-resolution", "product-invalid-resolution");
  await expectProductEvidenceInvalid(run.id, "catrev_spine_000", "Product relationship resolution is invalid");
});

test("Product-only Official Source surfaces reconcile without fabricating a Card", async () => {
  const run = await collect("/reconciliation/product-only-surface", "product-only-surface");
  const reconciled = await prepareProductCandidate(run.id, "catrev_spine_000", "one-piece");
  expect(reconciled.records.cards ?? []).toEqual([]);
  expect(reconciled.records.printings ?? []).toEqual([]);
  expect(reconciled.records).toMatchObject({
    products: [
      expect.objectContaining({
        official_code: "ST-PRODUCT-ONLY",
        releases: [
          expect.objectContaining({
            status: "announced",
            date: { precision: "quarter", value: "2027-Q1" },
          }),
        ],
      }),
    ],
  });
  const revisionId = requiredString(
    (await approveNativeCandidate(reconciled.header, `publish-${reconciled.header.id}`)).document,
    "resulting_revision_id",
  );
  const exportedRelationships = await exportComponentRecords(revisionId, "relationships");
  expect(exportedRelationships).toContainEqual(
    expect.objectContaining({
      kind: "distribution-context-product",
      from: expect.objectContaining({ type: "distribution_context" }),
      to: expect.objectContaining({ type: "product" }),
      relationship_value: "ST-PRODUCT-ONLY",
    }),
  );
});

test.each([
  ["product-explicit-derived", "explicit", "derived"],
  ["product-deterministic-explicit", "deterministic", "explicit"],
])("relationship resolution %s rejects contradictory evidence coupling", async (scenario, resolution, category) => {
  const run = await collect(`/reconciliation/${scenario}`, `coupling-${scenario}`);
  await expectProductEvidenceInvalid(
    run.id,
    "catrev_spine_000",
    `${resolution} resolution requires ${category === "derived" ? "explicit" : "derived"} evidence`,
  );
});

async function prepareProductCandidate(runId: string, predecessor: string, game: string) {
  const header = await prepareNativeCandidate(runId, game, predecessor, `product-prepare-${runId}`);
  const records = await nativeCandidateRecords(requiredString(header, "id"));
  return { header, records };
}

async function productSourceFreshness() {
  const status = await get("/v1/status");
  expect(status.response.status).toBe(200);
  const rows = status.document.source_freshness as Record<string, unknown>[];
  return rows.find(({ game, area }) => game === "one-piece" && area === "products-and-releases");
}

async function expectProductEvidenceInvalid(runId: string, predecessor: string, detail: string) {
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: runId,
    supported_game: "one-piece",
    expected_game_revision_id: predecessor,
    idempotency_key: `product-invalid-${runId}`,
  });
  expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  const [candidate] = await waitForNativeCandidates(runId, 1, 15_000, { "one-piece": "failed" });
  expect(candidate).toMatchObject({ state: "failed", failure_code: "printing_reconciliation_blocked" });
  expect(candidate?.outcome).toMatchObject({
    state: "failed",
    diagnostics: [
      expect.objectContaining({ code: "retained_evidence_invalid", detail: expect.stringContaining(detail) }),
    ],
  });
}
