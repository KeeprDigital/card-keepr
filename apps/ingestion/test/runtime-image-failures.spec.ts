import { catalogueStore } from "../../../src/catalogue/shared";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import * as ingestionQueries from "./query-helpers/ingestion";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  capturePreparedAttempt,
  prepareCaptureAttempt,
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
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
  const run = await createCollection("image_failure_001", "https://official-source.invalid/cards");
  const storedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (root === undefined) throw new Error("pending root request missing");
  const [image] = await appendDiscoveredEvidenceRequests(catalogueStore(env.CATALOGUE_DB), storedRun, root, [
    {
      role: "image",
      url: "https://official-source.invalid/unavailable",
      headers: { accept: "*/*" },
    },
  ]);
  if (image === undefined) throw new Error("image request missing");

  const response = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(response.status).toBe(202);
  await response.body?.cancel();
  const completed = await waitForEvidenceCondition(run.id, (current) => current.state !== "collecting", 12_000);

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
  ).toEqual(
    [1, 2, 3, 4].map((attempt) => ({
      attempt_number: attempt,
      outcome: "http_failure",
      status: 503,
    })),
  );
  expect(
    await sourceEvidenceQueries
      .readSourceRequestsRequestIdStateForImageRequestThatExhaustsTransportRetriesFailsAloneCollection(env.CATALOGUE_DB)
      .bind(run.id)
      .all()
      .then(({ results }) => results),
  ).toEqual([
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
  expect(
    await sourceEvidenceQueries.countIngestionRunRetryPausesCount(env.CATALOGUE_DB).bind(run.id).first("count"),
  ).toBe(0);
  expect(
    await ingestionQueries.readIngestionRunTransitionsFromStateToState(env.CATALOGUE_DB).bind(run.id).first(),
  ).toMatchObject({
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
    requests: [
      {
        request_id: image.request_id,
        hostname: "official-source.invalid",
        failure_code: "source_image_retries_exhausted",
        attempt_count: 4,
      },
    ],
  });
});

// Storage is ours to recover: exhausting R2 retries for an image pauses the
// run exactly like any other role, with the request kept pending.
test("an image request that exhausts its storage retries still pauses the run", async () => {
  const run = await createCollection("image_failure_storage_001", "https://official-source.invalid/cards");
  const storedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (root === undefined) throw new Error("pending root request missing");
  const [image] = await appendDiscoveredEvidenceRequests(catalogueStore(env.CATALOGUE_DB), storedRun, root, [
    {
      role: "image",
      url: "https://official-source.invalid/cards",
      headers: { accept: "*/*" },
    },
  ]);
  if (image === undefined) throw new Error("image request missing");
  const outageBucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get" || property === "put" || property === "createMultipartUpload") {
        return async () => {
          throw new Error("synthetic R2 outage");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const prepared = await prepareCaptureAttempt(catalogueStore(env.CATALOGUE_DB), storedRun, image);
    if (prepared.kind !== "attempt") {
      throw new Error(`unexpected preparation result ${prepared.kind}`);
    }
    const result = await capturePreparedAttempt(
      catalogueStore(env.CATALOGUE_DB),
      outageBucket,
      env.OFFICIAL_SOURCE_TRANSPORT,
      storedRun,
      image,
      prepared,
    );
    expect(result.kind).toBe(attempt === 4 ? "done" : "wait");
  }
  expect(await ingestionQueries.readIngestionRunsState(env.CATALOGUE_DB).bind(run.id).first("state")).toBe("paused");
  expect(
    await sourceEvidenceQueries.readIngestionRunRetryPausesRequestIdPauseReason(env.CATALOGUE_DB).bind(run.id).first(),
  ).toMatchObject({
    request_id: image.request_id,
    pause_reason: "source_storage_retries_exhausted",
    failure_classification: "storage_failure",
  });
  expect(
    await sourceEvidenceQueries
      .readSourceRequestsStateFailureCodeForImageRequestThatExhaustsStorageRetriesStillPausesRun(env.CATALOGUE_DB)
      .bind(run.id, image.request_id)
      .first(),
  ).toMatchObject({
    state: "pending",
    failure_code: null,
  });
});

test("a run without failed images reports an empty failed-image summary", async () => {
  const run = await createCollection("image_failure_none_001", "https://official-source.invalid/cards");
  const response = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(response.status).toBe(202);
  await response.body?.cancel();
  const completed = await waitForEvidenceCondition(run.id, (current) => current.state === "parsing", 12_000);
  expect((completed.collection as { failed_images: unknown }).failed_images).toEqual({
    count: 0,
    detail_limit: 200,
    truncated: false,
    requests: [],
  });
});

// A terminal image outcome (a missing file, a relocated file, a body that
// violates its own contract) is a gap the catalogue can publish without:
// the request fails alone under a class-specific code and collection
// completes. Catalogue-fact roles keep every terminal outcome fatal
// (runtime-capture-failures.spec.ts). A redirect is recorded, never
// followed: following it would silently change the evidence origin.
for (const scenario of [
  {
    name: "a 404",
    key: "image_failure_not_found_001",
    url: "https://official-source.invalid/missing-image.png",
    failure_code: "source_image_not_found",
    attempts: [{ attempt_number: 1, outcome: "http_failure", status: 404 }],
  },
  {
    name: "a redirect",
    key: "image_failure_redirect_001",
    url: "https://official-source.invalid/redirect",
    failure_code: "source_image_redirected",
    attempts: [{ attempt_number: 1, outcome: "redirect", status: 302 }],
  },
  {
    name: "a body-contract violation",
    key: "image_failure_body_001",
    url: "https://official-source.invalid/body-failure",
    failure_code: "source_image_body_contract",
    // The body never arrives, so the attempt records no HTTP status.
    attempts: [1, 2, 3, 4].map((attempt) => ({
      attempt_number: attempt,
      outcome: "body_failure",
      status: null,
    })),
  },
]) {
  test(`an image request that gets ${scenario.name} fails alone and collection completes`, async () => {
    const run = await createCollection(scenario.key, "https://official-source.invalid/cards");
    const storedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
    const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
    if (root === undefined) throw new Error("pending root request missing");
    const [image] = await appendDiscoveredEvidenceRequests(catalogueStore(env.CATALOGUE_DB), storedRun, root, [
      { role: "image", url: scenario.url, headers: { accept: "*/*" } },
    ]);
    if (image === undefined) throw new Error("image request missing");

    const response = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
    expect(response.status).toBe(202);
    await response.body?.cancel();
    const completed = await waitForEvidenceCondition(run.id, (current) => current.state !== "collecting", 12_000);

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
    ).toEqual(scenario.attempts);
    // Only the root was captured: a redirected image never yields a
    // Source Snapshot from its redirect target.
    expect(completed.snapshots).toHaveLength(1);
    expect(
      await sourceEvidenceQueries
        .readSourceRequestsRequestIdStateForImageRequestThatExhaustsTransportRetriesFailsAloneCollection(
          env.CATALOGUE_DB,
        )
        .bind(run.id)
        .all()
        .then(({ results }) => results),
    ).toEqual([
      { request_id: "required-source", state: "observed", failure_code: null },
      {
        request_id: image.request_id,
        state: "failed",
        failure_code: scenario.failure_code,
      },
    ]);
    expect(
      await sourceEvidenceQueries.countIngestionRunRetryPausesCount(env.CATALOGUE_DB).bind(run.id).first("count"),
    ).toBe(0);

    const collection = completed.collection as {
      requests: { by_state: Record<string, number> };
      failed_images: Record<string, unknown>;
    };
    expect(collection.requests.by_state).toEqual({ observed: 1, failed: 1 });
    expect(collection.failed_images).toEqual({
      count: 1,
      detail_limit: 200,
      truncated: false,
      requests: [
        {
          request_id: image.request_id,
          hostname: "official-source.invalid",
          failure_code: scenario.failure_code,
          attempt_count: scenario.attempts.length,
        },
      ],
    });
  });
}
