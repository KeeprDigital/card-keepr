import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
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

test("reconciling a run with a failed image publishes the cards and records the missing Printing Image", async () => {
  const started = await postFixtureEvidence({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "reconcile-missing-image",
    requests: [{
      id: "cards",
      method: "GET",
      url: "https://official-source.invalid/reconciliation/card-without-printing",
      headers: { accept: "application/json" },
    }],
  });
  expect(started.response.status).toBe(201);
  const id = requiredString(started.document, "id");
  const storedRun = await requiredEvidenceRun(testEnv.CATALOGUE_DB, id);
  const root = (await pendingEvidenceRequests(testEnv.CATALOGUE_DB, id))[0];
  if (root === undefined) throw new Error("pending root request missing");
  const [image] = await appendDiscoveredEvidenceRequests(
    testEnv.CATALOGUE_DB,
    storedRun,
    root,
    [{
      role: "image",
      url: "https://official-source.invalid/unavailable",
      headers: { accept: "*/*" },
    }],
  );
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
    source_url: "https://official-source.invalid/unavailable",
    source_lineage: "one-piece-en",
    failure_code: "source_image_retries_exhausted",
    detail: expect.any(String),
  });
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});
