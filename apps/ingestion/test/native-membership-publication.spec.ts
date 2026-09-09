import { expect, test } from "vitest";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { collect, exportComponentRecords, installReconciliationSuite, requiredString } from "./reconciliation-helpers";

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

test("native memberships publish derived targets and relationships while source buckets remain private", async () => {
  const run = await collect("/reconciliation/new-locator", "membership-targets");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "membership-targets-prepare");
  const records = await nativeCandidateRecords(requiredString(candidate, "id"));
  expect(records.products).toEqual([expect.objectContaining({ official_code: "product_promotion" })]);
  expect(records.distribution_contexts).toEqual([
    expect.objectContaining({ kind: "other", label: "context_event", product_id: null }),
  ]);
  expect(records.product_relationships).toHaveLength(2);
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
        evidence_category: "derived",
        relationship_value: "product_promotion",
        source_observation_ids: [expect.any(String)],
        lifecycle: expect.objectContaining({ current: true, first_revision_id: revision }),
      }),
      expect.objectContaining({
        kind: "printing-distribution-context",
        from: { type: "printing", id: printings[0]!.id },
        to: { type: "distribution_context", id: contexts[0]!.id },
        evidence_category: "derived",
        relationship_value: "context_event",
        source_observation_ids: [expect.any(String)],
        lifecycle: expect.objectContaining({ current: true, first_revision_id: revision }),
      }),
    ]),
  );
  expect(relationships).toHaveLength(2);
  expect(printings[0]!.products).toEqual([expect.objectContaining({ id: products[0]!.id })]);
  expect(printings[0]!.distribution_contexts).toEqual([expect.objectContaining({ id: contexts[0]!.id })]);
  expect(JSON.stringify({ products, contexts, relationships, printings })).not.toContain("promotion-list");
});
