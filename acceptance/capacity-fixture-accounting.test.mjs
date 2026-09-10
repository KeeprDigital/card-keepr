import assert from "node:assert/strict";
import test from "node:test";
import { capacityStorageBudget } from "./helpers/capacity-storage-budget.mjs";

test("storage planning counts coexisting copies once and leaves unknown components unresolved", () => {
  const workload = { imageBytes: 600, structuredBytes: 400 };
  const unknown = capacityStorageBudget(workload);
  assert.equal(unknown.known_lower_bound_bytes, 1000);
  assert.equal(unknown.total_bytes, null);
  assert.ok(unknown.unmeasured_components.includes("restore_staging"));
  const budget = capacityStorageBudget(workload, {
    sealed_records: 300,
    records_indexes_d1: 200,
    published_image_copies: 600,
    history_exports: 500,
    concurrent_work: 1000,
    restore_staging: 1500,
    filesystem_overhead: 100,
  });
  assert.equal(budget.total_bytes, 5200);
  assert.deepEqual(budget.unmeasured_components, []);
  assert.throws(() => capacityStorageBudget(workload, { restore_staging: -1 }));
});

import { retainedSourceCensus } from "../scripts/source-evidence/capacity-census.mjs";

test("retained real workloads count response bytes and expose incomplete image coverage", async () => {
  const census = await retainedSourceCensus();
  assert.equal(census.one_piece.bandai_p001.source_records, 7);
  assert.equal(census.one_piece.bandai_p001.image_body_bytes, 1403621);
  assert.equal(census.one_piece.limitless_p001.source_records, 8);
  assert.equal(census.one_piece.limitless_p001.image_body_bytes, 885446);
  assert.equal(census.riftbound.source_records, 1189);
  assert.equal(census.riftbound.unique_image_urls, 1189);
  assert.equal(census.riftbound.unretained_image_urls, 1183);
  assert.equal(census.riftbound.unretained_image_bytes, null);
  assert.equal(census.riftbound.mapper_inventory.document_body_bytes, 3249095);
  assert.deepEqual(
    census.riftbound.pages.map((page) => page.returned_records),
    [200, 198, 200, 198, 198, 195],
  );
  assert.equal(census.riftbound.pages[0].publisher_reported_records, 1197);
  assert.deepEqual(census.all_retained_inputs, {
    responses: 43,
    document_responses: 21,
    image_responses: 22,
    document_body_bytes: 7471079,
    image_body_bytes: 9104686,
    header_bytes: 29036,
  });
});
