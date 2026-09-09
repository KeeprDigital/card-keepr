import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import {
  approve,
  get,
  installReconciliationSuite,
  postFixtureEvidence,
  reconcile,
  requiredString,
  testEnv,
  waitForRunState,
} from "./reconciliation-helpers";

installReconciliationSuite();

// Every tolerated image failure, whether the transport retries ran out or
// the outcome was terminal (a missing or relocated file), reconciles the
// same way: the cards publish and the gap is recorded under its own code.
for (const scenario of [
  {
    name: "exhausted its retries",
    key: "reconcile-missing-image",
    url: "https://official-source.invalid/unavailable",
    failure_code: "source_image_retries_exhausted",
  },
  {
    name: "was not found",
    key: "reconcile-missing-image-not-found",
    url: "https://official-source.invalid/missing-image.png",
    failure_code: "source_image_not_found",
  },
  {
    name: "was one of 32 missing images",
    key: "reconcile-32-missing-images",
    url: "https://official-source.invalid/missing-image.png",
    failure_code: "source_image_not_found",
    imageCount: 32,
  },
  {
    name: "was redirected",
    key: "reconcile-missing-image-redirected",
    url: "https://official-source.invalid/redirect",
    failure_code: "source_image_redirected",
  },
]) {
  test(`reconciling a run whose image ${scenario.name} publishes the cards and records the missing Printing Image`, async () => {
    const started = await postFixtureEvidence({
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: scenario.key,
      requests: [
        {
          id: "cards",
          method: "GET",
          url: "https://official-source.invalid/reconciliation/card-without-printing",
          headers: { accept: "application/json" },
        },
      ],
    });
    expect(started.response.status).toBe(201);
    const id = requiredString(started.document, "id");
    const storedRun = await requiredEvidenceRun(catalogueStore(testEnv.CATALOGUE_DB), id);
    const root = (await pendingEvidenceRequests(catalogueStore(testEnv.CATALOGUE_DB), id))[0];
    if (root === undefined) throw new Error("pending root request missing");
    const imageCount = scenario.imageCount ?? 1;
    const [image] = await appendDiscoveredEvidenceRequests(
      catalogueStore(testEnv.CATALOGUE_DB),
      storedRun,
      root,
      Array.from({ length: imageCount }, (_, index) => ({
        role: "image" as const,
        url: index === 0 ? scenario.url : `${scenario.url}?image=${index}`,
        headers: { accept: "*/*" },
      })),
    );
    if (image === undefined) throw new Error("image request missing");
    await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, testEnv.OFFICIAL_SOURCE_TRANSPORT, id);
    await waitForRunState(id, "parsing");

    // The failed image is not missing catalogue facts: the candidate carries
    // the cards and an explicit, safe record of the Printing Image gap.
    const reconciled = await reconcile(id);
    if (reconciled.response.status !== 200) {
      throw new Error(JSON.stringify(reconciled.document));
    }
    expect(reconciled.document.cards).toHaveLength(1);
    expect(reconciled.document.warnings).toContainEqual({
      code: "printing_image_unavailable",
      request_id: image.request_id,
      source_url: scenario.url,
      source_lineage: "one-piece-en",
      failure_code: scenario.failure_code,
      detail: expect.any(String),
    });
    if (imageCount === 32) {
      expect(
        (reconciled.document.warnings as { code: string }[]).filter(
          ({ code }) => code === "printing_image_unavailable",
        ),
      ).toHaveLength(32);
      const status = (await get(`/v1/ingestion-runs/${id}/reconciliation`)).document;
      const checkpoint = (status.checkpoints as { phase: string; ordinal: number; cursor: unknown }[]).find(
        ({ phase }) => phase === "initial_warnings",
      );
      expect(checkpoint).toMatchObject({ cursor: { complete: true, processedWarnings: 32 } });
      expect(checkpoint!.ordinal).toBeGreaterThanOrEqual(3);
    }
    const published = await approve(reconciled.document);
    expect(published.response.status).toBe(200);
  });
}
