import { expect, test } from "vitest";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import {
  approveNativeCandidateThroughBinding as approveNativeCandidate,
  prepareNativeCandidateThroughBinding as prepareNativeCandidate,
} from "./native-publication-helpers";
import { publicComponents } from "./query-helpers/atomic-publication";
import { readCatalogueExportsManifestKey } from "./query-helpers/catalogue-export";
import {
  collect,
  exportComponentRecords,
  exportManifest,
  installReconciliationSuite,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("native export fixtures follow all public pages and reject broken manifest references or component bytes", async () => {
  const source = await collect("/reconciliation/curated-conflict-fanout-base", "native-export-reader-source");
  const candidate = await prepareNativeCandidate(
    source.id,
    "one-piece",
    "catrev_spine_000",
    "native-export-reader-candidate",
  );
  const inspected = await nativeCandidateRecords(String(candidate.id));
  const publication = await approveNativeCandidate(candidate, "native-export-reader-publication");
  const revision = String(publication.document.resulting_revision_id);
  const cards = await exportComponentRecords(revision, "cards");
  expect(cards).toHaveLength(32);
  expect(cards.map(({ id }) => id).sort()).toEqual(inspected.cards!.map(({ id }) => id).sort());
  expect(cards.every(({ type, game }) => type === "card" && game === "one-piece")).toBe(true);
  const page = await exportManifest(revision);
  expect(page.page?.next_cursor).toEqual(expect.any(String));
  expect(page.components).toHaveLength(4);

  const manifestKey = await readCatalogueExportsManifestKey(testEnv.CATALOGUE_DB)
    .bind(revision)
    .first<string>("manifest_key");
  if (manifestKey === null) throw new Error("Native manifest receipt is missing.");
  const manifest = await testEnv.CATALOGUE_EXPORTS.get(manifestKey);
  if (manifest === null) throw new Error("Native manifest is missing.");
  const manifestBytes = await manifest.arrayBuffer();
  try {
    await testEnv.CATALOGUE_EXPORTS.put(
      manifestKey,
      JSON.stringify({
        contract: "card-keepr-prepared-publication-composition@1",
        games: [{ artifacts: { object_key: "missing" } }],
      }),
    );
    await expect(exportComponentRecords(revision, "cards")).rejects.toThrow(
      "immutable package manifest failed verification",
    );
  } finally {
    await testEnv.CATALOGUE_EXPORTS.put(manifestKey, manifestBytes);
  }

  const component = (await publicComponents(testEnv.CATALOGUE_DB, String(candidate.id))).results.find(
    ({ kind }) => kind === "cards",
  );
  if (component === undefined) throw new Error("Native Card component is missing.");
  const object = await testEnv.CATALOGUE_EXPORTS.get(component.object_key);
  if (object === null) throw new Error("Native Card bytes are missing.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    await testEnv.CATALOGUE_EXPORTS.delete(component.object_key);
    await expect(exportComponentRecords(revision, "cards")).rejects.toThrow("verified public component is unavailable");
    const corrupted = bytes.slice();
    corrupted[0] = corrupted[0]! ^ 1;
    await testEnv.CATALOGUE_EXPORTS.put(component.object_key, corrupted);
    await expect(exportComponentRecords(revision, "cards")).rejects.toThrow(
      "immutable public component failed verification",
    );
  } finally {
    await testEnv.CATALOGUE_EXPORTS.put(component.object_key, bytes);
  }
  expect(await exportComponentRecords(revision, "cards")).toEqual(cards);
});
