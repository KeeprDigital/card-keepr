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

test("a 1001-entity reconciliation publishes atomically within bounded D1 statement budgets", async () => {
  const run = await collect("/reconciliation/scale-1001-cards", "bounded-d1-scale-1001-cards", undefined, 30_000);
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "bounded-cards-candidate");
  const candidateId = requiredString(candidate, "id");
  const records = await nativeCandidateRecords(candidateId, ["cards"]);
  expect(records.cards).toHaveLength(1_001);
  const cardIds = records.cards!.map((card) => requiredString(card, "id"));
  expect(new Set(cardIds).size).toBe(1_001);
  const partitions = await candidatePartitions(candidate);
  expect(partitions.length).toBeGreaterThan(32);
  const cardPartitions = partitions.filter(({ kind }) => kind === "cards");
  expect(cardPartitions.length).toBeLessThan(900);
  const cardBytes = cardPartitions.reduce((bytes, row) => bytes + row.byte_length, 0);
  expect(cardBytes).toBeLessThan(16 * 1024 * 1024);
  // Native preparation retains inspection alongside facts; no aggregate candidate is materialized.
  expect(cardBytes).toBeGreaterThan(8 * 1024 * 1024);
  const publicReplay = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "bounded-cards-candidate",
  });
  expect(publicReplay.response.status).toBe(200);
  expect(publicReplay.document).toEqual(candidate);
  expect(new TextEncoder().encode(JSON.stringify(publicReplay.document)).byteLength).toBeLessThan(70_000);
  expect((await currentGameMembers(testEnv.CATALOGUE_DB)).results).toEqual([]);
  const published = await approveNativeCandidate(candidate, "bounded-cards-approval");
  const revisionId = requiredString(published.document, "resulting_revision_id");
  expect((await currentGameMembers(testEnv.CATALOGUE_DB)).results).toEqual([
    expect.objectContaining({ candidate_id: candidateId, supported_game: "one-piece" }),
  ]);
  const exported = await exportComponentRecords(revisionId, "cards");
  expect(exported).toHaveLength(1_001);
  expect(exported.map(({ id }) => id).sort()).toEqual([...cardIds].sort());
  // The native consumer projection must preserve every large field verbatim.
  for (const card of records.cards!) {
    expect(exported.find(({ id }) => id === card.id)).toMatchObject({ game_data: card.game_data });
  }
  const searchMaterialization = await cardSearchQueries
    .measurePublicationCardSearchChunks(testEnv.CATALOGUE_DB)
    .bind(candidateId)
    .first<{ chunk_count: number; maximum_chunk_length: number; chunk_bytes: number }>();
  expect(searchMaterialization?.chunk_count).toBeGreaterThan(0);
  expect(searchMaterialization?.chunk_count).toBeLessThanOrEqual(3 * 1_001);
  expect(searchMaterialization?.maximum_chunk_length).toBeLessThanOrEqual(12 * 1024);
  expect(searchMaterialization?.chunk_bytes).toBeLessThan(16 * 1024 * 1024);
  const found: string[] = [];
  let after: string | null = null;
  do {
    const response = await compositionEntityResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      new Request(
        `https://card-keepr.invalid/v1/cards?revision=${revisionId}&q=Scale-search&limit=100` +
          (after === null ? "" : `&after=${encodeURIComponent(after)}`),
      ),
      { origin: "https://card-keepr.invalid", basePath: "" },
      "cards",
    );
    expect(response?.status).toBe(200);
    const page = await response!.json<{ data: { id: string }[]; page: { next_cursor: string | null } }>();
    expect(page.data.length).toBeLessThanOrEqual(100);
    found.push(...page.data.map(({ id }) => id));
    after = page.page.next_cursor;
  } while (after !== null);
  expect(found.sort()).toEqual([...cardIds].sort());
  let compressedBytes = 0;
  for await (const component of exportComponents(revisionId)) compressedBytes += component.compressed_bytes;
  expect(compressedBytes).toBeGreaterThan(1_048_576);
}, 180_000);

test("a Product-heavy export publishes bounded verified R2 components", async () => {
  const run = await collect(
    "/reconciliation/scale-1001-products",
    "bounded-export-scale-1001-products",
    undefined,
    45_000,
  );
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "bounded-products-candidate");
  await candidatePartitions(candidate);
  const published = await approveNativeCandidate(candidate, "bounded-products-approval");
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const [products, releases, contexts] = await Promise.all([
    exportComponentRecords(revisionId, "products"),
    exportComponentRecords(revisionId, "releases"),
    exportComponentRecords(revisionId, "distribution-contexts"),
  ]);
  const scaleProducts = products.filter(({ official_code }) => /^SC-[0-9]{4}$/u.test(String(official_code)));
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

test("128 synthetic images of 100 KiB reconcile and publish as immutable references", async () => {
  const { collectRequests } = await import("./reconciliation-helpers");
  const run = await collectRequests(
    Array.from({ length: 16 }, (_, index) => ({ id: `images-${index}`, scenario: `scale-128-images-${index}` })),
    "bounded-128-images",
  );
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "bounded-images-candidate");
  const partitions = await candidatePartitions(candidate);
  expect(partitions.reduce((sum, partition) => sum + partition.byte_length, 0)).toBeLessThan(1024 * 1024);
  const records = await nativeCandidateRecords(requiredString(candidate, "id"), ["printing_images"]);
  const images = records.printing_images as CataloguePrintingImage[];
  expect(images).toHaveLength(128);
  expect(images.reduce((sum, image) => sum + image.content_byte_length, 0)).toBe(13107200);
  expect(JSON.stringify(images)).not.toContain("content_base64");
  const published = await approveNativeCandidate(candidate, "bounded-images-approval");
  const revision = requiredString(published.document, "resulting_revision_id");
  for (const image of images) {
    const served = await compositionImageResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.PRINTING_IMAGES,
      new Request(`https://card-keepr.invalid/v1/printing-images/${image.id}/content?revision=${revision}`),
      image.id,
    );
    expect(served?.status).toBe(200);
    const bytes = await served!.arrayBuffer();
    expect(bytes.byteLength).toBe(image.content_byte_length);
    expect(await sha256(bytes)).toBe(image.content_sha256);
  }
  const exported = await exportComponentRecords(revision, "printing-images");
  expect(exported.map(({ id }) => id).sort()).toEqual(images.map(({ id }) => id).sort());
  expect(JSON.stringify(exported)).not.toContain("content_base64");
}, 60000);

test("warning-heavy evidence seals bounded warning partitions without copying all warnings into each plan", async () => {
  const { get } = await import("./reconciliation-helpers");
  const run = await collect("/reconciliation/scale-warning-partitions", "warning-partition-budget");
  const candidate = await prepareNativeCandidate(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "warning-partition-candidate",
  );
  const warnings = (await candidatePartitions(candidate)).filter((row) => row.kind === "warnings");
  expect(warnings.length).toBeGreaterThan(1);
  expect(warnings.reduce((sum, row) => sum + row.byte_length, 0)).toBeGreaterThan(524288);
  expect(warnings.every((row) => row.byte_length <= 524288)).toBe(true);
  const warningRecords = await nativeCandidateRecords(requiredString(candidate, "id"), ["warnings"]);
  expect(JSON.stringify(warningRecords.warnings)).toContain(`unrecognized_0_${"x".repeat(9000)}`);
  const status = await get(`/v1/game-candidates/${candidate.id}`);
  expect(JSON.stringify(status.document).length).toBeLessThan(70000);
  expect((await approveNativeCandidate(candidate, "warning-partition-approval")).response.status).toBe(200);
});

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
