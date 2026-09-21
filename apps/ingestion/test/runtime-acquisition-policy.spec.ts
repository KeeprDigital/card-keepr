import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  collectSourceRequestBatch,
  pendingEvidenceRequests,
  resumePausedEvidenceRun,
  showEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/admin-openapi.json";

installRuntimeSuite();

test("raw body exposure pauses before another GET and checked byte extension preserves counters and intent", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const budget = {
    max_dispatches: 4,
    max_source_bytes: 16 * 1024 * 1024,
    dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
  };
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_bytes_001",
    acquisition_budget: budget,
    requests: [1, 2].map((number) => ({
      id: `request-${number}`,
      url: `https://acquisition-official-source.invalid/sequence/${number}`,
    })),
  });
  const runId = String(created.id);
  let calls = 0;
  let receivedBytes = 0;
  const input = {
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        receivedBytes += (await response.clone().arrayBuffer()).byteLength;
        return response;
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests: await pendingEvidenceRequests(database, runId),
  };
  await collectSourceRequestBatch(input);
  expect(calls).toBe(1);
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "source_bytes" },
    acquisition: {
      generation: 1,
      charged_dispatches: 1,
      charged_source_bytes: receivedBytes,
      reserved_source_bytes: 0,
      remaining_dispatches: 3,
      limiting_dimension: "source_bytes",
      remaining_source_bytes: budget.max_source_bytes - receivedBytes,
    },
  });
  const endpoint = `/v1/ingestion-runs/${runId}/acquisition-budget/extension`;
  const extension = {
    expected_generation: 1,
    expected_budget: budget,
    acquisition_budget: { ...budget, max_source_bytes: 32 * 1024 * 1024 },
    idempotency_key: "acquisition_bytes_extension_001",
  };
  const stillExhausted = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/resume`, "POST");
  expect(stillExhausted.status).toBe(409);
  await stillExhausted.body?.cancel();
  for (const change of [
    { expected_generation: 2 },
    { expected_budget: { ...budget, max_dispatches: 3 } },
    { acquisition_budget: { ...extension.acquisition_budget, max_dispatches: 3 } },
    { acquisition_budget: budget },
  ]) {
    const rejected = await administrationRequest(endpoint, "POST", { ...extension, ...change });
    expect([409, 422]).toContain(rejected.status);
    await rejected.body?.cancel();
  }
  const first = await administrationRequest(endpoint, "POST", extension);
  expect(first.status).toBe(200);
  const receipt = await first.json();
  await assertHttpResponse(contract, "/v1/ingestion-runs/{run}/acquisition-budget/extension", "post", first, receipt);
  const replay = await administrationRequest(endpoint, "POST", extension);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  const changed = await administrationRequest(endpoint, "POST", {
    ...extension,
    acquisition_budget: { ...extension.acquisition_budget, max_dispatches: 5 },
  });
  expect(changed.status).toBe(409);
  await changed.body?.cancel();
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    acquisition: { generation: 2, charged_dispatches: 1, charged_source_bytes: receivedBytes },
  });
  await resumePausedEvidenceRun(database, runId);
  await collectSourceRequestBatch({ ...input, requests: await pendingEvidenceRequests(database, runId) });
  expect(calls).toBe(2);
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    id: runId,
    acquisition: {
      generation: 2,
      charged_dispatches: 2,
      charged_source_bytes: receivedBytes,
      reserved_source_bytes: 0,
    },
  });
  expect(await pendingEvidenceRequests(database, runId)).toEqual([]);
});

test("the deadline stops new admission without cancelling a body already admitted", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const deadline = Date.now() + 2_000;
  const budget = {
    max_dispatches: 4,
    max_source_bytes: 64 * 1024 * 1024,
    dispatch_deadline: new Date(deadline).toISOString(),
  };
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_deadline_001",
    acquisition_budget: budget,
    requests: [1, 2].map((number) => ({
      id: `request-${number}`,
      url: `https://acquisition-official-source.invalid/sequence/${number}`,
    })),
  });
  const runId = String(created.id);
  let calls = 0;
  let firstBody: Uint8Array | undefined;
  const input = {
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        if (calls === 1) {
          firstBody = new Uint8Array(await response.clone().arrayBuffer());
          // The real deadline is the boundary under test, including D1's clock.
          // Release this response only once that exact boundary has passed.
          while (Date.now() <= deadline)
            await new Promise((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now() + 1)));
        }
        return response;
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests: await pendingEvidenceRequests(database, runId),
  };
  await collectSourceRequestBatch(input);
  expect(calls).toBe(1);
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "deadline" },
    acquisition: { charged_dispatches: 1, charged_source_bytes: firstBody!.byteLength, reserved_source_bytes: 0 },
  });
  const extended = await administrationRequest(`/v1/ingestion-runs/${runId}/acquisition-budget/extension`, "POST", {
    expected_generation: 1,
    expected_budget: budget,
    acquisition_budget: { ...budget, dispatch_deadline: new Date(Date.now() + 60_000).toISOString() },
    idempotency_key: "acquisition_deadline_extension_001",
  });
  expect(extended.status).toBe(200);
  await extended.body?.cancel();
  await resumePausedEvidenceRun(database, runId);
  await collectSourceRequestBatch({ ...input, requests: await pendingEvidenceRequests(database, runId) });
  expect(calls).toBe(2);
  const shown = await showEvidenceRun(database, runId);
  const snapshots = shown.snapshots as Array<{ request: { url: string }; content: { object_key: string } }>;
  const first = snapshots.find((snapshot) => snapshot.request.url === input.requests[0]!.url)!;
  const object = await env.EVIDENCE_OBJECTS.get(first.content.object_key);
  expect(new Uint8Array(await object!.arrayBuffer())).toEqual(firstBody);
  expect(await pendingEvidenceRequests(database, runId)).toEqual([]);
});
