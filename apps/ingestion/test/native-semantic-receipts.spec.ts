import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { reconciliationCheckpoint } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import {
  collect,
  exportComponentRecords,
  exportManifest,
  get,
  installReconciliationSuite,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("native semantic digest excludes refreshed locator evidence while inspection retains it", async () => {
  const firstRun = await collect("/reconciliation/semantic-evidence-base", "semantic-receipt-base");
  const first = await prepareNativeCandidate(firstRun.id, "one-piece", "catrev_spine_000", "semantic-base-prepare");
  const firstRecords = await nativeCandidateRecords(requiredString(first, "id"));
  const firstDigest = await semanticDigest(first);
  const published = await approveNativeCandidate(first, "semantic-base-publish");
  const revision = requiredString(published.document, "resulting_revision_id");
  const firstManifest = await exportManifest(revision);
  const firstPrintings = await exportComponentRecords(revision, "printings");
  const firstEvidence = (await get(`/v1/ingestion-runs/${firstRun.id}/evidence`)).document;

  const relocatedRun = await collect("/reconciliation/semantic-evidence-locator", "semantic-receipt-relocated");
  const relocated = await prepareNativeCandidate(relocatedRun.id, "one-piece", revision, "semantic-relocated-prepare");
  const relocatedRecords = await nativeCandidateRecords(requiredString(relocated, "id"));
  expect(relocated.manifest_digest).not.toBe(first.manifest_digest);
  expect(relocatedRecords.cards).toEqual(firstRecords.cards);
  expect(firstRecords.printings).toHaveLength(1);
  expect(relocatedRecords.printings).toHaveLength(1);
  const firstPrinting = firstRecords.printings![0]!;
  const relocatedPrinting = relocatedRecords.printings![0]!;
  expect(relocatedPrinting.id).toBe(firstPrinting.id);
  expect(relocatedPrinting.locator_evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ locator: "/official/evidence/base" }),
      expect.objectContaining({ locator: "/official/evidence/relocated" }),
    ]),
  );
  expect(relocatedPrinting.locator_evidence).not.toEqual(firstPrinting.locator_evidence);
  expect((await get(`/v1/ingestion-runs/${firstRun.id}/evidence`)).document.snapshots).toEqual(firstEvidence.snapshots);
  expect(await exportManifest(revision)).toEqual(firstManifest);
  expect(await exportComponentRecords(revision, "printings")).toEqual(firstPrintings);
  expect(await semanticDigest(relocated)).toBe(firstDigest);
});

async function semanticDigest(candidate: Record<string, unknown>): Promise<string> {
  const checkpoint = await reconciliationCheckpoint<{ digest: string }>(
    catalogueStore(testEnv.CATALOGUE_DB),
    requiredString(candidate, "id"),
    "canonical_digest:catalogue",
  );
  expect(checkpoint?.value.digest).toMatch(/^[a-f0-9]{64}$/);
  return checkpoint!.value.digest;
}
