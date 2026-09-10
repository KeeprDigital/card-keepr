import { expect } from "vitest";
import { publicationBackupReservation } from "../../../src/catalogue/backup-recovery";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import { publicationLeaseMilliseconds } from "../../../src/catalogue/ingestion/run-types";
import { reconciliationPublication } from "../../../src/catalogue/reconciliation";
import {
  type CatalogueCandidate,
  catalogueRevisionIdentity,
  catalogueStore,
  sha256,
} from "../../../src/catalogue/shared";
import { waitNativeState } from "./native-no-change-helpers";
import { waitForVerifiedPublicationBackup } from "./native-publication-helpers";
import { setIngestionRunsStateApprovalJson } from "./query-helpers/ingestion";
import { readReconciliationPayloadChunks } from "./query-helpers/reconciliation";
import { get, post, requiredString, testEnv } from "./reconciliation-helpers";

/** Seed only retained historical materializers; current publication fixtures must use native approval. */
export async function stageHistoricalPublication(runId: string, approvalKey: string) {
  const inspection = await get(`/v1/ingestion-runs/${runId}/candidate`);
  expect(inspection.response.status, JSON.stringify(inspection.document)).toBe(200);
  const shown = inspection.document;
  const digest = requiredString(shown, "candidate_digest");
  const predecessor = requiredString(shown, "expected_current_revision_id");
  const retained = await readReconciliationPayloadChunks(testEnv.CATALOGUE_DB)
    .bind(runId)
    .first<{ candidate_json: string; candidate_catalogue_digest: string }>();
  if (retained === null) throw new Error("Historical candidate bytes are missing.");
  const candidate = JSON.parse(retained.candidate_json) as CatalogueCandidate;
  const revisionId = await catalogueRevisionIdentity({
    runId,
    candidateDigest: digest,
    expectedCurrentRevisionId: predecessor,
  });
  const approvedAt = new Date().toISOString();
  const expiredAt = new Date(Date.parse(approvedAt) + publicationLeaseMilliseconds).toISOString();
  const plan = await reconciliationPublication(catalogueStore(testEnv.CATALOGUE_DB), runId, revisionId, approvedAt);
  const exported = await buildCatalogueExport(
    candidate,
    retained.candidate_catalogue_digest,
    revisionId,
    approvedAt,
    plan === null
      ? undefined
      : {
          cards: plan.cardLifecycles,
          printings: plan.printingLifecycles,
          products: plan.productLifecycles,
          productRelationships: plan.productRelationshipLifecycles,
          erratumTargets: plan.erratumTargetLifecycles,
          relationships: plan.relationshipEvidence,
          locators: plan.locatorEvidence,
          cardEvidence: plan.cardEvidence,
          printingEvidence: plan.printingEvidence,
        },
  );

  // These are the already-written immutable objects of an interrupted old writer,
  // not a request for the retired route to allocate or write a new publication.
  for (const image of candidate.printing_images ?? []) {
    if (image.content_base64 !== undefined) {
      const bytes = Uint8Array.from(atob(image.content_base64), (character) => character.charCodeAt(0));
      expect(bytes.byteLength).toBe(image.content_byte_length);
      expect(await sha256(bytes)).toBe(image.content_sha256);
      expect(image.object_key).toBe(`printing-images/${image.content_sha256}`);
      await testEnv.PRINTING_IMAGES.put(image.object_key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: image.content_sha256,
        httpMetadata: { contentType: image.media_type },
        customMetadata: { sha256: image.content_sha256 },
      });
    }
    const object = await testEnv.PRINTING_IMAGES.get(image.object_key);
    if (object === null) throw new Error("Historical Printing Image is missing.");
    expect(object.size).toBe(image.content_byte_length);
    expect(await sha256(new Uint8Array(await object.arrayBuffer()))).toBe(image.content_sha256);
  }
  for (const object of exported.objects) {
    const body = object.body();
    await Promise.all([
      testEnv.CATALOGUE_EXPORTS.put(object.key, body.readable, { sha256: object.sha256 }),
      body.completed,
    ]);
  }
  const approval = {
    action: "approved",
    approved_at: approvedAt,
    candidate_digest: digest,
    expected_current_revision_id: predecessor,
  };
  await setIngestionRunsStateApprovalJson(testEnv.CATALOGUE_DB)
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval"],
        current_stage: "publishing",
      }),
      revisionId,
      approvedAt,
      expiredAt,
      exported.manifest.manifest_sha256,
      `writer:${revisionId}`,
      runId,
    )
    .run();
  const request = { candidate_digest: digest, expected_current_revision_id: predecessor, idempotency_key: approvalKey };
  return {
    request,
    expiredAt,
    revisionId,
    manifestDigest: exported.manifest.manifest_sha256,
    empty: candidate.cards.length === 0 && (candidate.products?.length ?? 0) === 0,
  };
}

export async function recoverHistoricalPublication(
  runId: string,
  approvalKey: string,
  expectedBackup: "verified" | "empty-historical" = "verified",
) {
  const { request, expiredAt, revisionId, manifestDigest, empty } = await stageHistoricalPublication(
    runId,
    approvalKey,
  );
  const recovered = await post(`/v1/ingestion-runs/${runId}/approval`, request, { "x-keepr-test-now": expiredAt });
  expect(recovered.response.status, JSON.stringify(recovered.document)).toBe(200);
  expect(recovered.document).toMatchObject({
    state: "published",
    resulting_revision_id: revisionId,
    export_manifest_digest: manifestDigest,
  });
  expect((await post(`/v1/ingestion-runs/${runId}/approval`, request)).document).toEqual(recovered.document);
  const backup = await publicationBackupReservation(revisionId);
  if (expectedBackup === "empty-historical") {
    // The old verification contract deliberately rejects a vacuous catalogue.
    // Projection-repair fixtures retain that real failure instead of inventing a verified backup.
    expect(empty).toBe(true);
    const failed = await waitNativeState(`/v1/backups/${backup.idempotencyKey}`, ["failed", "verified"]);
    expect(failed).toMatchObject({ state: "failed", failure: { detail: "Restored D1 verification failed." } });
  } else await waitForVerifiedPublicationBackup(backup.idempotencyKey, revisionId);
  return recovered;
}
