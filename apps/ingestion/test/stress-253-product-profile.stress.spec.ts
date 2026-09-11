import * as cardSearchQueries from "./query-helpers/card-search";
import { expect, test } from "vitest";
import { catalogueStore, sha256, type CataloguePrintingImage } from "../../../src/catalogue/shared";
import { compositionEntityResponse, compositionImageResponse } from "../../../src/catalogue/read/composition-read";
import { currentGameMembers, publicComponents } from "./query-helpers/atomic-publication";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import {
  installReconciliationSuite,
  testEnv,
  collect,
  exportComponentRecords,
  nativeExportManifestPage,
  post,
  requiredString,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("a Product-heavy export publishes bounded verified R2 components", async ({task}) => { const measureStart=Date.now(); task.meta.productPhases=[]; (globalThis as unknown as {profile253:unknown[]}).profile253=task.meta.productPhases as unknown[];
  const run = await collect(
    "/reconciliation/scale-1001-products",
    "bounded-export-scale-1001-products",
    undefined,
    45_000,
  );
  (globalThis as unknown as { profile253: unknown[] }).profile253.push({scope:"product",phase:"collected",milliseconds:Date.now()-measureStart}); console.info("[PROFILE-253-product]", "collected", Date.now()-measureStart);const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "bounded-products-candidate");
  (globalThis as unknown as { profile253: unknown[] }).profile253.push({scope:"product",phase:"prepared",milliseconds:Date.now()-measureStart}); console.info("[PROFILE-253-product]", "prepared", Date.now()-measureStart);await candidatePartitions(candidate);
  (globalThis as unknown as { profile253: unknown[] }).profile253.push({scope:"product",phase:"partitions",milliseconds:Date.now()-measureStart}); console.info("[PROFILE-253-product]", "partitions", Date.now()-measureStart);const published = await approveNativeCandidate(candidate, "bounded-products-approval");
  (globalThis as unknown as { profile253: unknown[] }).profile253.push({scope:"product",phase:"publication-and-backup",milliseconds:Date.now()-measureStart}); console.info("[PROFILE-253-product]", "publication-and-backup", Date.now()-measureStart);expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const [products, releases, contexts] = await Promise.all([
    exportComponentRecords(revisionId, "products"),
    exportComponentRecords(revisionId, "releases"),
    exportComponentRecords(revisionId, "distribution-contexts"),
  ]);
  (globalThis as unknown as { profile253: unknown[] }).profile253.push({scope:"product",phase:"export-records",milliseconds:Date.now()-measureStart}); console.info("[PROFILE-253-product]", "export-records", Date.now()-measureStart);const scaleProducts = products.filter(({ official_code }) => /^SC-[0-9]{4}$/u.test(String(official_code)));
  expect(scaleProducts).toHaveLength(1_001);
  const scaleProductIds = new Set(scaleProducts.map(({ id }) => String(id)));
  expect(releases.filter(({ product_id }) => scaleProductIds.has(String(product_id)))).toHaveLength(1_001);
  expect(contexts.filter(({ product_id }) => scaleProductIds.has(String(product_id)))).toHaveLength(1_001);
  let productBytes = 0;
  for await (const component of exportComponents(revisionId)) {
    if (["products", "releases", "distribution-contexts"].includes(component.kind ?? ""))
      productBytes += component.uncompressed_bytes;
    expect(component.records).toBe(1);
  }
  expect(productBytes).toBeGreaterThan(8 * 1024 * 1024);
  const storedComponents = await publicComponents(testEnv.CATALOGUE_DB, requiredString(candidate, "id"));
  expect(storedComponents.results.length).toBeGreaterThanOrEqual(3 * 1_001);
  for (const component of storedComponents.results) {
    const stored = await testEnv.CATALOGUE_EXPORTS.get(component.object_key);
    expect(stored?.size).toBe(component.byte_length);
    // Native components retain an independently verified digest, not an R2 checksum field.
    expect(await sha256(await stored!.arrayBuffer())).toBe(component.sha256);
  }
}, 120_000);

async function candidatePartitions(candidate: Record<string, unknown>) {
  const { get } = await import("./reconciliation-helpers");
  const partitions: { ordinal: number; kind: string; byte_length: number; record_count: number }[] = [];
  let cursor: string | null = null;
  do {
    const page = await get(
      `/v1/game-candidates/${candidate.id}/partitions?manifest=${candidate.manifest_digest}` +
        (cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`),
    );
    expect(page.response.status).toBe(200);
    const rows = page.document.partitions as typeof partitions;
    expect(rows.length).toBeLessThanOrEqual(100);
    expect(rows.every((row) => row.byte_length <= 524_288 && row.record_count <= 500)).toBe(true);
    partitions.push(...rows);
    const next = page.document.next_cursor as string | null;
    if (next !== null) expect(next).not.toBe(cursor);
    cursor = next;
  } while (cursor !== null);
  return partitions;
}

async function* exportComponents(revision: string) {
  let after: string | null = null;
  do {
    const page = await nativeExportManifestPage(revision, after);
    expect(page.components.length).toBeLessThanOrEqual(4);
    yield* page.components;
    const next = page.page!.next_cursor;
    if (next !== null) expect(next).not.toBe(after);
    after = next;
  } while (after !== null);
}
