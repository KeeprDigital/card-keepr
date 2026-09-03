import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  administrationRequest,
  createCollection,
  installRuntimeSuite,
  waitForEvidenceCondition,
} from "./runtime-helpers";

installRuntimeSuite();

// A Printing Image is a static file that reconciliation can publish without.
// Exhausting its bounded transport retries must record that one request as
// failed and let collection continue, instead of a Retry Pause per stubborn
// image; catalogue-fact roles keep the pause (runtime-retry-pause.spec.ts).
test("an image request that exhausts its transport retries fails alone and collection completes", async () => {
  const run = await createCollection(
    "image_failure_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending root request missing");
  const [image] = await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    [{
      role: "image",
      url: "https://official-source.invalid/unavailable",
      headers: { accept: "*/*" },
    }],
  );
  if (image === undefined) throw new Error("image request missing");

  const response = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(response.status).toBe(202);
  await response.body?.cancel();
  const completed = await waitForEvidenceCondition(
    run.id,
    (current) => current.state !== "collecting",
    12_000,
  );

  // Collection completed: the run moved on to parsing with no pause and no
  // run-level failure, and the image request alone carries the failure.
  expect(completed).toMatchObject({
    state: "parsing",
    failure_code: null,
    collection_completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  });
  expect(completed.pause ?? null).toBeNull();
  expect(
    completed.diagnostics
      .filter((diagnostic) => diagnostic.request_id === image.request_id)
      .map((diagnostic) => ({
        attempt_number: diagnostic.attempt_number,
        outcome: diagnostic.outcome,
        status: diagnostic.http_status,
      })),
  ).toEqual([1, 2, 3, 4].map((attempt) => ({
    attempt_number: attempt,
    outcome: "http_failure",
    status: 503,
  })));
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT request_id, state, failure_code FROM source_requests
     WHERE ingestion_run_id = ? ORDER BY sequence_number`,
  ).bind(run.id).all().then(({ results }) => results)).toEqual([
    {
      request_id: "required-source",
      state: "observed",
      failure_code: null,
    },
    {
      request_id: image.request_id,
      state: "failed",
      failure_code: "source_image_retries_exhausted",
    },
  ]);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_retry_pauses
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(0);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT from_state, to_state FROM ingestion_run_transitions
     WHERE ingestion_run_id = ? ORDER BY sequence DESC LIMIT 1`,
  ).bind(run.id).first()).toMatchObject({
    from_state: "collecting",
    to_state: "parsing",
  });

  // The operator can see the gap: `source show` summarises the failed
  // images of the run with safe references only.
  const collection = completed.collection as {
    requests: { by_state: Record<string, number> };
    failed_images: Record<string, unknown>;
  };
  expect(collection.requests.by_state).toEqual({ observed: 1, failed: 1 });
  expect(collection.failed_images).toEqual({
    count: 1,
    detail_limit: 200,
    truncated: false,
    requests: [{
      request_id: image.request_id,
      hostname: "official-source.invalid",
      failure_code: "source_image_retries_exhausted",
      attempt_count: 4,
    }],
  });
});

test("a run without failed images reports an empty failed-image summary", async () => {
  const run = await createCollection(
    "image_failure_none_001",
    "https://official-source.invalid/cards",
  );
  const response = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(response.status).toBe(202);
  await response.body?.cancel();
  const completed = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "parsing",
    12_000,
  );
  expect(
    (completed.collection as { failed_images: unknown }).failed_images,
  ).toEqual({
    count: 0,
    detail_limit: 200,
    truncated: false,
    requests: [],
  });
});
