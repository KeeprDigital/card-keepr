import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { acquisitionBarrier } from "./acquisition-barrier";
import { catalogueStore } from "../../../src/catalogue/shared";
import { beginEvidenceObjectWrite } from "../../../src/catalogue/source-evidence/evidence-cleanup-repository";
import {
  collectSourceRequestBatch,
  pendingEvidenceRequests,
  prepareCaptureAttempt,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
  showEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

test("a registered older writer blocks fresh dispatch even before its destination exists", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_older_writer_001",
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  const requests = await pendingEvidenceRequests(database, runId);
  const prepared = await prepareCaptureAttempt(database, await requiredEvidenceRun(database, runId), requests[0]!);
  if (prepared.kind !== "attempt") throw new Error("Expected an unstarted capture");
  await beginEvidenceObjectWrite(
    database,
    "older-physical-writer",
    runId,
    prepared.content_object_key,
    new Date().toISOString(),
  ).run();
  let calls = 0;
  await collectSourceRequestBatch({
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        return env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate",
    pacingIntervalMilliseconds: 0,
    requests,
  });
  expect(calls).toBe(0);
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "ownership" },
    acquisition: { charged_dispatches: 0, reserved_source_bytes: 0 },
    snapshots: [],
  });
  expect(await env.EVIDENCE_OBJECTS.head(prepared.content_object_key)).toBeNull();
  const resume = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/resume`, "POST");
  expect(resume.status).toBe(409);
  expect(await resume.json()).toMatchObject({ code: "source_acquisition_ownership_pending" });
});

test("a lost reservation acknowledgement remains charged and replay cannot spend its permit", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_lost_reservation_001",
    acquisition_budget: {
      max_dispatches: 3,
      max_source_bytes: 64 * 1024 * 1024,
      dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  const requests = await pendingEvidenceRequests(database, runId);
  // Prepare through the ordinary driver before arming the next durable transaction's lost response.
  await prepareCaptureAttempt(database, await requiredEvidenceRun(database, runId), requests[0]!);
  let acknowledgementLost = false;
  const unreliable = new Proxy(env.CATALOGUE_DB, {
    get(target, property) {
      if (property === "batch")
        return async (...args: Parameters<D1Database["batch"]>) => {
          const result = await target.batch(...args);
          if (!acknowledgementLost) {
            acknowledgementLost = true;
            throw new Error("controlled lost durable transaction acknowledgement");
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let calls = 0;
  const input = {
    database: catalogueStore(unreliable),
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        return env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests,
  };
  await expect(collectSourceRequestBatch(input)).rejects.toThrow("controlled lost durable transaction acknowledgement");
  await collectSourceRequestBatch({ ...input, database });
  expect(calls).toBe(0);
  const inspected = await showEvidenceRun(database, runId);
  expect(inspected).toMatchObject({
    state: "paused",
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "ownership" },
    acquisition: { charged_dispatches: 1, charged_source_bytes: 0, reserved_source_bytes: 16 * 1024 * 1024 },
  });
  const resume = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/resume`, "POST");
  expect(resume.status).toBe(409);
  expect(await resume.json()).toMatchObject({ code: "source_acquisition_ownership_pending" });
  expect(await pendingEvidenceRequests(database, runId)).toEqual(requests);
});

test("a second claimant pauses while the first capture write is held and cannot replace its destination", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_held_write_001",
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  const entered = acquisitionBarrier();
  const release = acquisitionBarrier();
  let writes = 0;
  let calls = 0;
  let expectedBody: Uint8Array | undefined;
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          writes++;
          entered.resolve();
          await release.promise;
          return target.put(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const input = {
    database,
    evidenceObjects: bucket,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        expectedBody = new Uint8Array(await response.arrayBuffer());
        return new Response(expectedBody, {
          headers: {
            "content-type": "application/json",
            "content-length": String(expectedBody.byteLength),
          },
        });
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests: await pendingEvidenceRequests(database, runId),
  };
  const first = collectSourceRequestBatch(input);
  void first.catch(entered.reject);
  try {
    await entered.promise;
    await collectSourceRequestBatch({ ...input, evidenceObjects: env.EVIDENCE_OBJECTS });
    expect(await showEvidenceRun(database, runId)).toMatchObject({
      state: "paused",
      pause: { reason: "source_acquisition_budget_exhausted", dimension: "ownership" },
      acquisition: { charged_dispatches: 1, charged_source_bytes: 0, reserved_source_bytes: 16 * 1024 * 1024 },
    });
    expect(calls).toBe(1);
    expect(writes).toBe(1);
  } finally {
    release.resolve();
    await first;
  }
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    acquisition: { charged_dispatches: 1, charged_source_bytes: expectedBody!.byteLength, reserved_source_bytes: 0 },
  });
  await resumePausedEvidenceRun(database, runId);
  await collectSourceRequestBatch({ ...input, evidenceObjects: env.EVIDENCE_OBJECTS });
  expect(calls).toBe(1);
  const shown = await showEvidenceRun(database, runId);
  const snapshots = shown.snapshots as Array<{ content: { object_key: string } }>;
  expect(snapshots).toHaveLength(1);
  const object = await env.EVIDENCE_OBJECTS.get(snapshots[0]!.content.object_key);
  expect(new Uint8Array(await object!.arrayBuffer())).toEqual(expectedBody);
});

test.each([true, false])(
  "a pre-existing destination stays intact and cannot settle another dispatch (length declared: %s)",
  async (declared) => {
    const database = catalogueStore(env.CATALOGUE_DB);
    const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: `acquisition_foreign_destination_${declared}`,
      requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
    });
    const runId = String(created.id);
    const requests = await pendingEvidenceRequests(database, runId);
    const prepared = await prepareCaptureAttempt(database, await requiredEvidenceRun(database, runId), requests[0]!);
    if (prepared.kind !== "attempt") throw new Error("Expected an unstarted capture");
    const retained = "another physical writer's immutable body";
    await env.EVIDENCE_OBJECTS.put(prepared.content_object_key, retained, {
      customMetadata: { cleanup_writer_token: "foreign-physical-writer" },
    });
    let calls = 0;
    await collectSourceRequestBatch({
      database,
      evidenceObjects: env.EVIDENCE_OBJECTS,
      officialSourceTransport: {
        fetch: async (_url: RequestInfo | URL) => {
          calls++;
          return new Response('{"cards":[]}', {
            headers: {
              "content-type": "application/json",
              ...(declared ? { "content-length": "12" } : {}),
            },
          });
        },
      } as Fetcher,
      runId,
      hostname: "acquisition-official-source.invalid",
      pacingMode: "immediate",
      pacingIntervalMilliseconds: 0,
      requests,
    });
    expect(calls).toBe(1);
    expect(await (await env.EVIDENCE_OBJECTS.get(prepared.content_object_key))!.text()).toBe(retained);
    expect(await showEvidenceRun(database, runId)).toMatchObject({
      state: "paused",
      pause: { reason: "source_acquisition_budget_exhausted", dimension: "ownership" },
      acquisition: { charged_dispatches: 1, charged_source_bytes: 0, reserved_source_bytes: 16 * 1024 * 1024 },
      snapshots: [],
    });
  },
);
