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

installRuntimeSuite();

test("a dispatch budget pauses untouched work and checked extension resumes the same collection", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const budget = {
    max_dispatches: 1,
    max_source_bytes: 64 * 1024 * 1024,
    dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
  };
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_tracer_001",
    acquisition_budget: budget,
    requests: [1, 2].map((number) => ({
      id: `request-${number}`,
      url: `https://acquisition-official-source.invalid/sequence/${number}`,
    })),
  });
  const runId = String(created.id);
  const requests = await pendingEvidenceRequests(database, runId);
  const calls: string[] = [];
  const sourceBodies = new Map<string, Uint8Array>();
  const input = {
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(url));
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        sourceBodies.set(String(url), new Uint8Array(await response.clone().arrayBuffer()));
        return response;
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests,
  };
  await collectSourceRequestBatch(input);
  const inspected = await administrationRequest(`/v1/ingestion-runs/${runId}/evidence`, "GET");
  expect(inspected.status).toBe(200);
  const paused = await inspected.json<Record<string, unknown>>();
  expect(paused).toMatchObject({
    id: runId,
    state: "paused",
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "dispatches" },
    acquisition: { generation: 1, charged_dispatches: 1, reserved_source_bytes: 0 },
  });
  expect(calls).toEqual([requests[0]!.url]);
  expect(await pendingEvidenceRequests(database, runId)).toEqual([
    expect.objectContaining({ request_id: requests[1]!.request_id, state: "pending" }),
  ]);
  const extended = await administrationRequest(`/v1/ingestion-runs/${runId}/acquisition-budget/extension`, "POST", {
    expected_generation: 1,
    expected_budget: budget,
    acquisition_budget: { ...budget, max_dispatches: 2 },
    idempotency_key: "acquisition_tracer_extension_001",
  });
  expect(extended.status).toBe(200);
  expect(await showEvidenceRun(database, runId)).toMatchObject({ state: "paused" });
  await resumePausedEvidenceRun(database, runId);
  await collectSourceRequestBatch({ ...input, requests: await pendingEvidenceRequests(database, runId) });
  expect(calls).toEqual(requests.map((request) => request.url));
  const finished = await showEvidenceRun(database, runId);
  expect(finished).toMatchObject({
    id: runId,
    acquisition: { generation: 2, charged_dispatches: 2, reserved_source_bytes: 0 },
  });
  expect(await pendingEvidenceRequests(database, runId)).toEqual([]);
  const snapshots = finished.snapshots as Array<{
    request: { url: string };
    content: { object_key: string; byte_length: number };
  }>;
  expect(snapshots).toHaveLength(2);
  for (const snapshot of snapshots) {
    const object = await env.EVIDENCE_OBJECTS.get(snapshot.content.object_key);
    const body = new Uint8Array(await object!.arrayBuffer());
    expect(body).toEqual(sourceBodies.get(snapshot.request.url));
    expect(body.byteLength).toBe(snapshot.content.byte_length);
  }
});
