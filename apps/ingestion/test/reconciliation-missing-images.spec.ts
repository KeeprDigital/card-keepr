import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import {
  approve,
  installReconciliationSuite,
  post,
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
    const storedRun = await requiredEvidenceRun(testEnv.CATALOGUE_DB, id);
    const root = (await pendingEvidenceRequests(testEnv.CATALOGUE_DB, id))[0];
    if (root === undefined) throw new Error("pending root request missing");
    const [image] = await appendDiscoveredEvidenceRequests(testEnv.CATALOGUE_DB, storedRun, root, [
      { role: "image", url: scenario.url, headers: { accept: "*/*" } },
    ]);
    if (image === undefined) throw new Error("image request missing");
    const resumed = await post(`/v1/ingestion-runs/${id}/collection/resume`, {});
    expect(resumed.response.status).toBe(202);
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
    const published = await approve(reconciled.document);
    expect(published.response.status).toBe(200);
  });
}
