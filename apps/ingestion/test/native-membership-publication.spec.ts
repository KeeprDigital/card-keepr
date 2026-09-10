import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { reconciliationCheckpoint } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { ReconciliationReducerIndex } from "../../../src/catalogue/reconciliation/reconciliation-reducer-state";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import {
  collect,
  exportComponentRecords,
  installReconciliationSuite,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("native membership-derived Product lifecycle includes every related Printing", async () => {
  const firstRun = await collect("/reconciliation/product-lifecycle-first", "membership-product-first");
  const first = await prepareNativeCandidate(firstRun.id, "one-piece", "catrev_spine_000", "membership-first-prepare");
  const firstRecords = await nativeCandidateRecords(requiredString(first, "id"));
  expect(firstRecords.products).toEqual([
    expect.objectContaining({
      game: "one-piece",
      official_code: "product_lifecycle_shared",
      name: "product_lifecycle_shared",
    }),
  ]);
  const firstPublished = await approveNativeCandidate(first, "membership-first-publish");
  const firstRevision = requiredString(firstPublished.document, "resulting_revision_id");
  const firstProducts = await exportComponentRecords(firstRevision, "products");
  expect(firstProducts).toHaveLength(1);

  const multipleRun = await collect("/reconciliation/product-lifecycle-multiple", "membership-product-multiple");
  const multiple = await prepareNativeCandidate(
    multipleRun.id,
    "one-piece",
    firstRevision,
    "membership-multiple-prepare",
  );
  const multiplePublished = await approveNativeCandidate(multiple, "membership-multiple-publish");
  const latestRevision = requiredString(multiplePublished.document, "resulting_revision_id");
  const products = await exportComponentRecords(latestRevision, "products");
  expect(products).toEqual([
    expect.objectContaining({
      id: firstProducts[0]!.id,
      game: "one-piece",
      official_code: "product_lifecycle_shared",
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: latestRevision,
        withdrawn: false,
      },
    }),
  ]);
  expect(JSON.stringify(products)).not.toContain("membership_evidence");
  expect(JSON.stringify(products)).not.toContain("source_observation");
});

test("native membership history preserves unchecked lineages and accepts a repeated disappearance without changing facts", async () => {
  async function prepare(scenario: string, region: "asia" | "us", revision: string, key: string) {
    const run = await collect(`/reconciliation/${scenario}`, key, {
      game: "gundam",
      lineage: `gundam-en-${region}`,
      adapter: `fixture-gundam-en-${region}-json@2`,
    });
    return prepareNativeCandidate(run.id, "gundam", revision, `${key}-prepare`);
  }
  const asia = await prepare("gundam-membership-asia", "asia", "catrev_spine_000", "membership-asia");
  const asiaPublished = await approveNativeCandidate(asia, "membership-asia-publish");
  const asiaRevision = requiredString(asiaPublished.document, "resulting_revision_id");
  const us = await prepare("gundam-membership-us", "us", asiaRevision, "membership-us");
  const usRecords = await nativeCandidateRecords(requiredString(us, "id"));
  expect(usRecords.product_relationships).toHaveLength(4);
  const preparation = requiredString(us, "preparation_id");
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const checkpoint = await reconciliationCheckpoint<{ memberships: number }>(db, preparation, "semantic_preparation");
  const memberships = new ReconciliationReducerIndex<{ id: string; value: Record<string, unknown> }>(
    db,
    preparation,
    "semantic_membership_values",
  );
  memberships.resumeAt(checkpoint!.value.memberships);
  const current = [];
  for await (const membership of memberships.entityValues()) current.push(membership.value);
  expect(current).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source_lineage: "gundam-en-asia", relationship_value: "membership-product-asia" }),
      expect.objectContaining({ source_lineage: "gundam-en-asia", relationship_value: "membership-context-asia" }),
      expect.objectContaining({ source_lineage: "gundam-en-us", relationship_value: "membership-product-us" }),
      expect.objectContaining({ source_lineage: "gundam-en-us", relationship_value: "membership-context-us" }),
    ]),
  );
  expect(current).toHaveLength(4);
  const usPublished = await approveNativeCandidate(us, "membership-us-publish");
  const usRevision = requiredString(usPublished.document, "resulting_revision_id");
  const missing = await prepare("gundam-membership-asia-missing", "asia", usRevision, "membership-asia-missing");
  const missingRecords = await nativeCandidateRecords(requiredString(missing, "id"));
  expect(
    missingRecords.product_relationships?.filter(({ source_lineage }) => source_lineage === "gundam-en-asia"),
  ).toEqual([expect.objectContaining({ observed: false }), expect.objectContaining({ observed: false })]);
  expect(
    missingRecords.product_relationships?.filter(({ source_lineage }) => source_lineage === "gundam-en-us"),
  ).toEqual([expect.objectContaining({ observed: true }), expect.objectContaining({ observed: true })]);
  const missingPublished = await approveNativeCandidate(missing, "membership-missing-publish");
  const revision = requiredString(missingPublished.document, "resulting_revision_id");
  const contexts = await exportComponentRecords(revision, "distribution-contexts");
  expect(contexts).toEqual([expect.objectContaining({ label: "membership-context-us" })]);
  const products = await exportComponentRecords(revision, "products");
  expect(products).toHaveLength(2);
  expect(products.find(({ official_code }) => official_code === "membership-product-asia")).toMatchObject({
    lifecycle: { first_revision_id: asiaRevision, last_observed_revision_id: asiaRevision, withdrawn: false },
  });
  const repeated = await prepare("gundam-membership-asia-missing", "asia", revision, "membership-missing-repeat");
  expect(repeated.canonical_digest).toBe(missing.canonical_digest);
  const repeatedPublished = await approveNativeCandidate(repeated, "membership-missing-repeat-publish");
  expect(repeatedPublished.document.resulting_revision_id).toBe(revision);
});

test("native memberships publish derived targets and relationships while source buckets remain private", async () => {
  const run = await collect("/reconciliation/new-locator", "membership-targets");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "membership-targets-prepare");
  const records = await nativeCandidateRecords(requiredString(candidate, "id"));
  expect(records.products).toEqual([expect.objectContaining({ official_code: "product_promotion" })]);
  expect(records.distribution_contexts).toEqual([
    expect.objectContaining({ kind: "other", label: "context_event", product_id: null }),
  ]);
  expect(records.product_relationships).toHaveLength(2);
  for (const relationship of records.product_relationships!)
    expect(relationship).toMatchObject({
      evidence_category: "derived",
      source_lineage: expect.any(String),
      source_observation_ids: [expect.any(String)],
      observed: true,
    });
  const published = await approveNativeCandidate(candidate, "membership-targets-publish");
  const revision = requiredString(published.document, "resulting_revision_id");
  const products = await exportComponentRecords(revision, "products");
  const contexts = await exportComponentRecords(revision, "distribution-contexts");
  const printings = await exportComponentRecords(revision, "printings");
  const relationships = await exportComponentRecords(revision, "relationships");
  expect(products).toHaveLength(1);
  expect(contexts).toHaveLength(1);
  expect(relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "printing-product",
        from: { type: "printing", id: printings[0]!.id },
        to: { type: "product", id: products[0]!.id },
        relationship_value: "product_promotion",
        lifecycle: expect.objectContaining({ current: true, first_revision_id: revision }),
      }),
      expect.objectContaining({
        kind: "printing-distribution-context",
        from: { type: "printing", id: printings[0]!.id },
        to: { type: "distribution_context", id: contexts[0]!.id },
        relationship_value: "context_event",
        lifecycle: expect.objectContaining({ current: true, first_revision_id: revision }),
      }),
    ]),
  );
  expect(relationships).toHaveLength(2);
  expect(printings[0]!.products).toEqual([expect.objectContaining({ id: products[0]!.id })]);
  expect(printings[0]!.distribution_contexts).toEqual([expect.objectContaining({ id: contexts[0]!.id })]);
  expect(JSON.stringify({ products, contexts, relationships, printings })).not.toContain("promotion-list");
  expect(JSON.stringify(relationships)).not.toContain("source_observation");
});
