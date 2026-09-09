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
