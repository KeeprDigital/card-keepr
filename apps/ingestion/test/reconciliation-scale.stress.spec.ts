import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import * as cardSearchQueries from "./query-helpers/card-search";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as catalogueExportQueries from "./query-helpers/catalogue-export";
import { expect, test } from "vitest";
import {
  installReconciliationSuite,
  testEnv,
  approve,
  collect,
  exportComponentRecords,
  exportManifest,
  post,
  reconcile,
  requiredString,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("a 1001-entity reconciliation publishes atomically within bounded D1 statement budgets", async () => {
  const run = await collect("/reconciliation/scale-1001-cards", "bounded-d1-scale-1001-cards", undefined, 30_000);
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  expect(reconciled.response.status).toBe(200);
  expect(Array.isArray(reconciled.document.cards) ? reconciled.document.cards : []).toHaveLength(1_001);
  const publicCardIds = (Array.isArray(reconciled.document.cards) ? reconciled.document.cards : []).map((card) =>
    requiredString(card as Record<string, unknown>, "id"),
  );
  expect(new Set(publicCardIds).size).toBe(1_001);
  if (!("workflow_instance_id" in reconciled)) {
    throw new Error("Expected an accepted reconciliation Workflow.");
  }
  const workflowInstance = await testEnv.RECONCILIATION_WORKFLOW.get(reconciled.workflow_instance_id);
  const workflowStatus = await workflowInstance.status();
  expect(workflowStatus.status).toBe("complete");
  const durableOutputBytes = new TextEncoder().encode(JSON.stringify(workflowStatus.output)).byteLength;
  expect(durableOutputBytes).toBeLessThan(1_048_576);
  expect(workflowStatus.output).toMatchObject({
    result_json: expect.stringContaining("card-keepr-reconciliation-workflow-result@1"),
  });
  const publicReplay = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, {
    expected_current_revision_id: requiredString(reconciled.document, "expected_current_revision_id"),
    idempotency_key: `reconcile-${run.id}`,
  });
  expect(publicReplay.response.status).toBe(200);
  expect(publicReplay.document.output).toEqual(reconciled.document);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const persisted = await publishedCatalogueQueries
    .countRevisionCardsCount(testEnv.CATALOGUE_DB)
    .bind(revisionId)
    .first<{ count: number }>();
  expect(persisted?.count).toBeGreaterThan(1_000);
  expect(await exportComponentRecords(revisionId, "cards")).toHaveLength(persisted?.count ?? 0);
  const chunks = await reconciliationQueries
    .countReconciliationPayloadChunksCountBLOB(testEnv.CATALOGUE_DB)
    .bind(run.id)
    .first<{
      count: number;
      maximum_bytes: number;
      candidate_bytes: number;
    }>();
  expect(chunks?.count).toBeGreaterThan(32);
  expect(chunks?.count).toBeLessThan(900);
  expect(chunks?.maximum_bytes).toBeLessThanOrEqual(524_288);
  expect(chunks?.candidate_bytes).toBeGreaterThan(8 * 1024 * 1024);
  expect(chunks?.candidate_bytes).toBeLessThan(16 * 1024 * 1024);
  const searchMaterialization = await cardSearchQueries
    .measureRevisionCardSearchChunks(testEnv.CATALOGUE_DB)
    .bind(revisionId, JSON.stringify(publicCardIds))
    .first<{
      chunk_count: number;
      maximum_chunk_length: number;
      chunk_bytes: number;
    }>();
  expect(searchMaterialization?.chunk_count).toBeLessThanOrEqual(3 * 1_001);
  expect(searchMaterialization?.maximum_chunk_length).toBeLessThanOrEqual(12 * 1024);
  expect(searchMaterialization?.chunk_bytes).toBeLessThan(16 * 1024 * 1024);
  const storedRun = await ingestionQueries
    .readIngestionRunsCandidateJson(testEnv.CATALOGUE_DB)
    .bind(run.id)
    .first<{ candidate_json: string }>();
  expect(storedRun?.candidate_json).toContain('"chunked_reconciliation_payload":"candidate"');
  const exportRow = await catalogueExportQueries
    .readCatalogueExportsManifestKey(testEnv.CATALOGUE_DB)
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifest = await (await testEnv.CATALOGUE_EXPORTS.get(exportRow?.manifest_key ?? ""))?.json<{
    components: { compressed_bytes: number }[];
  }>();
  expect(manifest?.components.reduce((total, component) => total + component.compressed_bytes, 0)).toBeGreaterThan(
    1_048_576,
  );
}, 180_000);

test("a Product-heavy export publishes bounded verified R2 components", async () => {
  const run = await collect(
    "/reconciliation/scale-1001-products",
    "bounded-export-scale-1001-products",
    undefined,
    45_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const [products, releases, contexts, manifest] = await Promise.all([
    exportComponentRecords(revisionId, "products"),
    exportComponentRecords(revisionId, "releases"),
    exportComponentRecords(revisionId, "distribution-contexts"),
    exportManifest(revisionId),
  ]);
  const scaleProducts = products.filter(({ official_code }) => /^SC-[0-9]{4}$/u.test(String(official_code)));
  expect(scaleProducts).toHaveLength(1_001);
  const scaleProductIds = new Set(scaleProducts.map(({ id }) => String(id)));
  expect(releases.filter(({ product_id }) => scaleProductIds.has(String(product_id)))).toHaveLength(1_001);
  expect(contexts.filter(({ product_id }) => scaleProductIds.has(String(product_id)))).toHaveLength(1_001);
  const productBytes = manifest.components
    .filter(({ name }) => ["products", "releases", "distribution-contexts"].includes(name))
    .reduce((total, component) => total + component.uncompressed_bytes, 0);
  expect(productBytes).toBeGreaterThan(8 * 1024 * 1024);
  for (const component of manifest.components) {
    const key = `catalogue-exports/${revisionId}/components/` + `${component.compressed_sha256}.ndjson.gz`;
    const stored = await testEnv.CATALOGUE_EXPORTS.head(key);
    expect(stored?.size).toBe(component.compressed_bytes);
    expect(stored?.checksums.sha256).toBeDefined();
  }
}, 120_000);

test("128 synthetic images of 100 KiB reconcile and publish as immutable references", async () => {
  const { collectRequests } = await import("./reconciliation-helpers");
  const run = await collectRequests(
    Array.from({ length: 16 }, (_, index) => ({ id: `images-${index}`, scenario: `scale-128-images-${index}` })),
    "bounded-128-images",
  );
  const candidate = await reconcile(run.id, {}, 30000);
  expect(candidate.response.status).toBe(200);
  const { get } = await import("./reconciliation-helpers");
  const manifest = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`);
  const partitions = manifest.document.partitions as { ordinal: number; kind: string; byte_length: number }[];
  expect(partitions.reduce((sum, partition) => sum + partition.byte_length, 0)).toBeLessThan(1024 * 1024);
  const images = [];
  for (const partition of partitions.filter((partition) => partition.kind === "printing_images")) {
    const detail = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${partition.ordinal}`);
    images.push(...(detail.document.records as { content_byte_length: number; object_key: string }[]));
  }
  expect(images).toHaveLength(128);
  expect(images.reduce((sum, image) => sum + image.content_byte_length, 0)).toBe(13107200);
  expect(JSON.stringify(images)).not.toContain("content_base64");
  expect((await approve(candidate.document)).response.status).toBe(200);
}, 60000);

test("warning-heavy evidence seals bounded warning partitions without copying all warnings into each plan", async () => {
  const { get } = await import("./reconciliation-helpers");
  const run = await collect("/reconciliation/scale-warning-partitions", "warning-partition-budget");
  const result = await reconcile(run.id);
  expect(result.response.status, JSON.stringify(result.document)).toBe(200);
  const page = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`);
  const warnings = (page.document.partitions as { kind: string; byte_length: number; record_count: number }[]).filter(
    (row) => row.kind === "warnings",
  );
  expect(warnings.length).toBeGreaterThan(1);
  expect(warnings.reduce((sum, row) => sum + row.byte_length, 0)).toBeGreaterThan(524288);
  expect(warnings.every((row) => row.byte_length <= 524288)).toBe(true);
  const runStatus = await get(`/v1/ingestion-runs/${run.id}`);
  expect(JSON.stringify(runStatus.document).length).toBeLessThan(70000);
  expect((await approve(result.document)).response.status).toBe(200);
});
