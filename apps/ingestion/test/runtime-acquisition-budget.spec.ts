import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { acquisitionBarrier } from "./acquisition-barrier";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  collectSourceRequestBatch,
  beginEvidenceCleanup,
  advanceEvidenceCleanup,
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

test("a verified upload recovers a lost write acknowledgement without another dispatch or retained exposure", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_lost_upload_001",
    acquisition_budget: {
      max_dispatches: 1,
      max_source_bytes: 16 * 1024 * 1024,
      dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  let calls = 0;
  let acknowledgementLost = false;
  let expectedBody: Uint8Array | undefined;
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await target.put(...args);
          if (!acknowledgementLost && result !== null) {
            acknowledgementLost = true;
            throw new Error("controlled lost write acknowledgement after durable storage");
          }
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await collectSourceRequestBatch({
    database,
    evidenceObjects: bucket,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        expectedBody = new Uint8Array(await response.arrayBuffer());
        return new Response(expectedBody, {
          headers: { "content-type": "application/json", "content-length": String(expectedBody.byteLength) },
        });
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate",
    pacingIntervalMilliseconds: 0,
    requests: await pendingEvidenceRequests(database, runId),
  });
  expect(acknowledgementLost).toBe(true);
  expect(calls).toBe(1);
  const shown = await showEvidenceRun(database, runId);
  expect(shown).toMatchObject({
    acquisition: {
      charged_dispatches: 1,
      charged_source_bytes: expectedBody!.byteLength,
      reserved_source_bytes: 0,
      unsettled: [],
    },
  });
  const snapshots = shown.snapshots as Array<{ content: { object_key: string } }>;
  expect(snapshots).toHaveLength(1);
  const retained = await env.EVIDENCE_OBJECTS.get(snapshots[0]!.content.object_key);
  expect(new Uint8Array(await retained!.arrayBuffer())).toEqual(expectedBody);
});

test("an owner pause cannot resume while a physical fetch is held, and its late completion settles only its own exposure", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_held_fetch_001",
    acquisition_budget: {
      max_dispatches: 4,
      max_source_bytes: 64 * 1024 * 1024,
      dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  const entered = acquisitionBarrier();
  const release = acquisitionBarrier();
  let calls = 0;
  let expectedBody: Uint8Array | undefined;
  const input = {
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        expectedBody = new Uint8Array(await response.clone().arrayBuffer());
        entered.resolve();
        await release.promise;
        return response;
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests: await pendingEvidenceRequests(database, runId),
  };
  const inFlight = collectSourceRequestBatch(input);
  void inFlight.catch(entered.reject);
  try {
    await entered.promise;
    const pause = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/pause`, "POST", {
      idempotency_key: "acquisition_held_fetch_pause_001",
    });
    expect(pause.status).toBe(200);
    await pause.body?.cancel();
    const resume = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/resume`, "POST");
    expect(resume.status).toBe(409);
    expect(await resume.json()).toMatchObject({ code: "source_acquisition_ownership_pending" });
    await collectSourceRequestBatch(input);
    expect(calls).toBe(1);
    expect(await showEvidenceRun(database, runId)).toMatchObject({
      state: "paused",
      acquisition: { charged_dispatches: 1, charged_source_bytes: 0, reserved_source_bytes: 16 * 1024 * 1024 },
    });
  } finally {
    release.resolve();
    await inFlight;
  }
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    acquisition: { charged_dispatches: 1, charged_source_bytes: expectedBody!.byteLength, reserved_source_bytes: 0 },
  });
  await resumePausedEvidenceRun(database, runId);
  await collectSourceRequestBatch(input);
  expect(calls).toBe(1);
  const finished = await showEvidenceRun(database, runId);
  expect(finished.snapshots).toHaveLength(1);
});

test("a fetch already admitted before termination protects its possible late write from cleanup", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_cleanup_fetch_001",
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  const entered = acquisitionBarrier();
  const release = acquisitionBarrier();
  const inFlight = collectSourceRequestBatch({
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        entered.resolve();
        await release.promise;
        return response;
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate",
    pacingIntervalMilliseconds: 0,
    requests: await pendingEvidenceRequests(database, runId),
  }).then(
    () => null,
    (error: unknown) => {
      entered.reject(error);
      return error;
    },
  );
  try {
    await entered.promise;
    const pause = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/pause`, "POST", {
      idempotency_key: "acquisition_cleanup_pause_001",
    });
    expect(pause.status).toBe(200);
    await pause.body?.cancel();
    const terminated = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/termination`, "POST", {
      idempotency_key: "acquisition_cleanup_termination_001",
    });
    expect(terminated.status).toBe(200);
    const document = await terminated.json<{ terminated_at: string }>();
    const due = new Date(Date.parse(document.terminated_at) + 31 * 86400000).toISOString();
    const cleanup = await beginEvidenceCleanup(database, runId, "acquisition_cleanup_intent_001", 30, due);
    expect(await advanceEvidenceCleanup(database, env.EVIDENCE_OBJECTS, cleanup.id, due)).toMatchObject({
      state: "paused",
      deleted_objects: 0,
      failure_code: "evidence_cleanup_writer_unsettled",
    });
    expect(await showEvidenceRun(database, runId)).toMatchObject({
      acquisition: { charged_dispatches: 1, reserved_source_bytes: 16 * 1024 * 1024 },
    });
  } finally {
    release.resolve();
    await inFlight;
  }
});
