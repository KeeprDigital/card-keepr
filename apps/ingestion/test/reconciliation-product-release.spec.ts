import { expect, test } from "vitest";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
import { compositionEntityResponse } from "../../../src/catalogue/read";
import { catalogueStore } from "../../../src/catalogue/shared";
import { nativeCandidateRecords, waitForNativeCandidates } from "./native-candidate-helpers";
import {
  approveNativeCandidateThroughBinding as approveNativeCandidate,
  prepareNativeCandidateThroughBinding as prepareNativeCandidate,
} from "./native-publication-helpers";
import {
  collect,
  collectRequests,
  exportComponentRecords,
  exportManifest,
  installReconciliationSuite,
  post,
  requiredFirst,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("a complete Product fixture publishes separated release and distribution records atomically", async () => {
  const run = await collect("/reconciliation/product-release", "product-release-complete-fixture");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "product-release-prepare");
  const records = await nativeCandidateRecords(requiredString(candidate, "id"));
  expect(records.warnings ?? []).toContainEqual(
    expect.objectContaining({
      code: "product_relationship_unresolved",
      relationship_value: "ST-15 fuzzy label",
    }),
  );
  const published = await approveNativeCandidate(candidate, "product-release-publish");
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const [products, releases, contexts, relationships, printings] = await Promise.all([
    exportComponentRecords(revisionId, "products"),
    exportComponentRecords(revisionId, "releases"),
    exportComponentRecords(revisionId, "distribution-contexts"),
    exportComponentRecords(revisionId, "relationships"),
    exportComponentRecords(revisionId, "printings"),
  ]);
  const product = products.find((entry) => entry.official_code === "ST-15");
  expect(product).toMatchObject({
    official_code: "ST-15",
    name: "Starter Deck RED Edward.Newgate",
    lifecycle: {
      first_revision_id: revisionId,
      last_observed_revision_id: revisionId,
      withdrawn: false,
    },
  });
  if (product === undefined) throw new Error("ST-15 Product missing");
  const productId = requiredString(product, "id");
  const release = releases.find((entry) => entry.product_id === productId && entry.region === "EN-OCEANIA");
  expect(release).toMatchObject({
    product_id: productId,
    region: "EN-OCEANIA",
    date: { precision: "month", value: "2026-09" },
    status: "announced",
  });
  expect(await exportManifest(revisionId)).not.toHaveProperty("source_freshness");
  const context = contexts.find(
    (entry) => entry.product_id === productId && entry.label === "Championship 2026 Participation Pack",
  );
  expect(context).toMatchObject({
    kind: "tournament_pack",
    label: "Championship 2026 Participation Pack",
    product_id: productId,
  });
  if (context === undefined) throw new Error("Distribution Context missing");
  const contextId = requiredString(context, "id");
  const productRelationship = relationships.find((relationship) => {
    const to = relationship.to;
    return (
      to !== null &&
      typeof to === "object" &&
      !Array.isArray(to) &&
      (to as Record<string, unknown>).type === "product" &&
      (to as Record<string, unknown>).id === productId
    );
  });
  expect(productRelationship).toEqual(
    expect.objectContaining({
      from: { type: "printing", id: expect.any(String) },
      to: { type: "product", id: productId },
    }),
  );
  if (productRelationship === undefined) {
    throw new Error("Printing-to-Product relationship missing");
  }
  const from = productRelationship.from;
  if (from === null || typeof from !== "object" || Array.isArray(from)) {
    throw new Error("Printing relationship source invalid");
  }
  const printingId = requiredString(from as Record<string, unknown>, "id");
  const printingCollection = await compositionEntityResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(
      `https://card-keepr.invalid/v1/printings?game=one-piece&product_id=${encodeURIComponent(productId)}&release_region=EN-OCEANIA`,
    ),
    { origin: "https://card-keepr.invalid", basePath: "" },
    "printings",
  );
  if (!printingCollection) throw new Error("Native Printing collection is unavailable.");
  expect(printingCollection.status).toBe(200);
  expect(await printingCollection.json()).toMatchObject({
    data: expect.arrayContaining([expect.objectContaining({ id: printingId })]),
    meta: { catalogue_revision_id: revisionId },
  });
  expect(printings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: printingId,
      }),
    ]),
  );
  expect(relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        from: { type: "printing", id: printingId },
        to: { type: "distribution_context", id: contextId },
      }),
    ]),
  );
  expect(
    JSON.stringify({
      product,
      release,
      context,
      relationships: relationships.filter((relationship) => {
        const relationshipFrom = relationship.from;
        return (
          relationshipFrom !== null &&
          typeof relationshipFrom === "object" &&
          !Array.isArray(relationshipFrom) &&
          (relationshipFrom as Record<string, unknown>).type === "printing" &&
          (relationshipFrom as Record<string, unknown>).id === printingId
        );
      }),
    }),
  ).not.toContain("starter-deck-card-list");
  expect(relationships.some((relationship) => relationship.relationship_value === "ST-15 fuzzy label")).toBe(false);
});

test("a Fusion Leader publishes immutable role-labelled Printing Images and export links", async () => {
  const run = await collect("/reconciliation/fusion-leader-images", `fusion-leader-images-${crypto.randomUUID()}`, {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const candidate = await prepareNativeCandidate(run.id, "fusion-world", "catrev_spine_000", "leader-images-prepare");
  const records = await nativeCandidateRecords(requiredString(candidate, "id"));
  const leaderPrintingId = requiredString(requiredFirst(records, "printings"), "id");
  const published = await approveNativeCandidate(candidate, "leader-images-publish");
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const images = (await exportComponentRecords(revisionId, "printing-images")).filter(
    ({ printing_id }) => printing_id === leaderPrintingId,
  );
  expect(images).toEqual([
    expect.objectContaining({
      type: "printing_image",
      role: "back",
      content_sha256: "eed832d958fc4054fffb3027319dcd914448475c226ce55ae8053a442ed1b2cf",
      id: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    }),
    expect.objectContaining({
      type: "printing_image",
      role: "front",
      content_sha256: "46f3e4bfb8bc9956482a6491e9b968d82e6fd544da44f9f36d93b443b845f773",
      id: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    }),
  ]);
  for (const image of images) {
    const object = await testEnv.PRINTING_IMAGES.get(`printing-images/${image.content_sha256}`);
    expect(object?.size).toBeGreaterThan(0);
    expect(object?.checksums.sha256).toBeDefined();
  }
});

test("distinct official Release events in one region retain stable public identities", async () => {
  const run = await collect("/reconciliation/product-release-multiple-events", "product-release-multiple-events");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "release-events-prepare");
  const published = await approveNativeCandidate(candidate, "release-events-publish");
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const product = (await exportComponentRecords(revisionId, "products")).find(
    ({ official_code }) => official_code === "ST-15",
  );
  if (product === undefined) throw new Error("ST-15 Product missing");
  const releases = (await exportComponentRecords(revisionId, "releases")).filter(
    ({ product_id }) => product_id === product.id,
  );
  expect(releases).toEqual([
    expect.objectContaining({
      event_key: "oceania-announcement",
      region: "EN-OCEANIA",
      date: { precision: "month", value: "2026-09" },
      status: "announced",
    }),
    expect.objectContaining({
      event_key: "oceania-retail-release",
      region: "EN-OCEANIA",
      date: { precision: "day", value: "2026-09-18" },
      status: "released",
    }),
  ]);
  expect(new Set(releases.map(({ id }) => id)).size).toBe(2);
});

test("a disappeared Distribution Context with no remaining lineage is not current", async () => {
  const firstRun = await collect("/reconciliation/product-release", "distribution-context-first-observation");
  const firstCandidate = await prepareNativeCandidate(
    firstRun.id,
    "one-piece",
    "catrev_spine_000",
    "context-first-prepare",
  );
  const firstPublished = await approveNativeCandidate(firstCandidate, "context-first-publish");
  expect(firstPublished.response.status).toBe(200);
  const firstRevisionId = requiredString(firstPublished.document, "resulting_revision_id");
  const firstContext = (await exportComponentRecords(firstRevisionId, "distribution-contexts")).find(
    ({ label }) => label === "Championship 2026 Participation Pack",
  );
  expect(firstContext?.id).toEqual(expect.any(String));

  const missingRun = await collect(
    "/reconciliation/product-standalone-missing",
    "distribution-context-complete-missing",
  );
  const missingCandidate = await prepareNativeCandidate(
    missingRun.id,
    "one-piece",
    firstRevisionId,
    "context-missing-prepare",
  );
  const published = await approveNativeCandidate(missingCandidate, "context-missing-publish");
  expect(published.response.status).toBe(200);
  const missingRecords = await nativeCandidateRecords(requiredString(missingCandidate, "id"));
  expect(missingRecords.distribution_contexts?.find(({ id }) => id === firstContext?.id)).toMatchObject({
    observed: false,
    source_lineages: [],
  });
  const missingRevisionId = requiredString(published.document, "resulting_revision_id");
  expect(await exportComponentRecords(missingRevisionId, "distribution-contexts")).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: firstContext?.id })]),
  );
}, 30_000);

test("registered Product detail evidence outranks its conflicting listing through publication", async () => {
  const requests = officialSourceDiscoveryRequests("fusion-world-en").map((request) => ({
    ...request,
    headers: {
      ...request.headers,
      "user-agent": "card-keepr-product-authority",
    },
  }));
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "registered-product-detail-authority",
    requests,
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  // Retain the registered adapter evidence before creating the per-game preparation.
  await collectFixtureEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    testEnv.OFFICIAL_SOURCE_TRANSPORT,
    runId,
  );
  const candidate = await prepareNativeCandidate(
    runId,
    "fusion-world",
    "catrev_spine_000",
    "detail-authority-prepare",
    20_000,
  );
  const published = await approveNativeCandidate(candidate, "detail-authority-publish");
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const retained = await nativeCandidateRecords(requiredString(candidate, "id"));
  const product = retained.products?.find(({ official_code }) => official_code === "FB-AUTHORITY");
  expect(product).toMatchObject({
    name: "Authoritative Product Detail [FB-AUTHORITY]",
    disagreements: [expect.objectContaining({ path: "/data/name", status: "resolved_by_authority" })],
  });
  expect(
    (await exportComponentRecords(revisionId, "products")).find(
      ({ official_code }) => official_code === "FB-AUTHORITY",
    ),
  ).toMatchObject({
    name: "Authoritative Product Detail [FB-AUTHORITY]",
  });
}, 30_000);

test("a registered code-less Product refresh preserves its established code", async () => {
  // The fusion-world-en@9 live listing derives Product codes from bracketed
  // titles, so a code cannot disappear while the published name stays
  // identical; the digimon-en listing keeps publishing explicit
  // data-product-code attributes and exercises the code-preserving refresh.
  const start = async (state: "coded" | "codeless", predecessor: string) => {
    const requests = officialSourceDiscoveryRequests("digimon-en").map((request) => ({
      ...request,
      headers: {
        ...request.headers,
        "user-agent": `card-keepr-product-identity-${state}`,
      },
    }));
    const started = await post("/v1/ingestion-runs/evidence", {
      supported_game: "digimon",
      source_lineage: "digimon-en",
      adapter_version: "digimon-en@7",
      idempotency_key: `registered-product-identity-${state}-${crypto.randomUUID()}`,
      requests,
    });
    expect(started.response.status).toBe(201);
    const runId = requiredString(started.document, "id");
    // Retain the registered adapter evidence before creating the per-game preparation.
    await collectFixtureEvidence(
      testEnv.CATALOGUE_DB,
      testEnv.EVIDENCE_OBJECTS,
      testEnv.OFFICIAL_SOURCE_TRANSPORT,
      runId,
    );
    return prepareNativeCandidate(runId, "digimon", predecessor, `registered-product-${state}-prepare`, 20_000);
  };

  const firstCandidate = await start("coded", "catrev_spine_000");
  const firstPublication = await approveNativeCandidate(firstCandidate, "registered-product-coded-publish");
  expect(firstPublication.response.status).toBe(200);
  const firstRevision = requiredString(firstPublication.document, "resulting_revision_id");
  const firstProduct = (await exportComponentRecords(firstRevision, "products")).find(
    ({ official_code }) => official_code === "FB-STABLE",
  );
  expect(firstProduct).toMatchObject({
    id: expect.any(String),
    name: "Stable Product Identity",
  });

  const refreshCandidate = await start("codeless", firstRevision);
  const refreshPublication = await approveNativeCandidate(refreshCandidate, "registered-product-codeless-publish");
  expect(refreshPublication.response.status, JSON.stringify(refreshPublication.document)).toBe(200);
  const refreshRevision = requiredString(refreshPublication.document, "resulting_revision_id");
  const productResponse = await compositionEntityResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`https://card-keepr.invalid/v1/products/${firstProduct?.id}`),
    { origin: "https://card-keepr.invalid", basePath: "" },
    "products",
    requiredString(firstProduct ?? {}, "id"),
  );
  if (!productResponse) throw new Error("Native Product detail is unavailable.");
  expect(productResponse.status).toBe(200);
  expect(await productResponse.json()).toMatchObject({
    data: { id: firstProduct?.id, official_code: "FB-STABLE" },
    meta: { catalogue_revision_id: refreshRevision },
  });
  expect(
    (await exportComponentRecords(refreshRevision, "products")).find(({ id }) => id === firstProduct?.id),
  ).toMatchObject({
    official_code: "FB-STABLE",
    name: "Stable Product Identity",
  });
}, 45_000);

test("a registered fuzzy Product link remains a review warning through publication", async () => {
  const requests = officialSourceDiscoveryRequests("digimon-en").map((request) => ({
    ...request,
    headers: {
      ...request.headers,
      "user-agent": "card-keepr-product-fuzzy-warning",
    },
  }));
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "digimon",
    source_lineage: "digimon-en",
    adapter_version: "digimon-en@7",
    idempotency_key: `registered-product-fuzzy-${crypto.randomUUID()}`,
    requests,
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  // Retain the registered adapter evidence before creating the per-game preparation.
  await collectFixtureEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    testEnv.OFFICIAL_SOURCE_TRANSPORT,
    runId,
  );
  const candidate = await prepareNativeCandidate(runId, "digimon", "catrev_spine_000", "fuzzy-link-prepare", 20_000);
  const records = await nativeCandidateRecords(requiredString(candidate, "id"));
  expect(records.warnings ?? []).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "product_relationship_unresolved",
        relationship_value: "Possible Booster Product",
      }),
    ]),
  );
  const publication = await approveNativeCandidate(candidate, "fuzzy-link-publish");
  expect(publication.response.status, JSON.stringify(publication.document)).toBe(200);
  const revisionId = requiredString(publication.document, "resulting_revision_id");
  expect(
    (records.product_relationships ?? []).filter(
      ({ relationship_value }) => relationship_value === "Possible Booster Product",
    ),
  ).toHaveLength(0);
  expect(
    (await exportComponentRecords(revisionId, "relationships")).some(
      ({ relationship_value }) => relationship_value === "Possible Booster Product",
    ),
  ).toBe(false);
}, 30_000);

test("same-authority Product conflicts fail closed before publication", async () => {
  const run = await collectRequests(
    [
      { id: "discovery", scenario: "complete-empty-lineage" },
      { id: "product-a", scenario: "product-conflict-a" },
      { id: "product-b", scenario: "product-conflict-b" },
    ],
    "product-conflicting-facts",
  );
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "product-conflict-prepare",
  });
  expect(created.response.status).toBe(201);
  const [candidate] = await waitForNativeCandidates(run.id, 1, 15_000, { "one-piece": "failed" });
  expect(candidate).toMatchObject({ state: "failed", failure_code: "printing_reconciliation_blocked" });
  expect(candidate?.outcome).toMatchObject({
    state: "failed",
    diagnostics: [
      expect.objectContaining({
        code: "retained_evidence_invalid",
        detail: expect.stringContaining("Same-authority Product evidence conflicts at /data/name"),
      }),
    ],
  });
});
