import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { acquisitionBarrier } from "./acquisition-barrier";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  collectSourceRequestBatch,
  pendingEvidenceRequests,
  showEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import { administrationRequest, installRuntimeSuite, waitForEvidenceCondition } from "./runtime-helpers";

installRuntimeSuite();

test("a response lost before its durable receipt cannot reuse the escaped dispatch on replay", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_lost_response_receipt_001",
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  let responseEscaped = false;
  let interrupted = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "run")
          return async () => {
            if (responseEscaped && !interrupted) {
              interrupted = true;
              throw new Error("controlled interruption before response receipt");
            }
            return target.run();
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const unreliable = new Proxy(env.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
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
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        responseEscaped = true;
        return response;
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests: await pendingEvidenceRequests(database, runId),
  };
  await expect(collectSourceRequestBatch(input)).rejects.toThrow("controlled interruption before response receipt");
  await collectSourceRequestBatch({ ...input, database });
  expect(calls).toBe(1);
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "ownership" },
    acquisition: { charged_dispatches: 1, charged_source_bytes: 0, reserved_source_bytes: 16 * 1024 * 1024 },
    snapshots: [],
  });
});

test("replay settles an uploaded receipt after the accounting transaction was unavailable without refetching", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_settlement_outage_001",
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  let outage = false;
  const unreliable = new Proxy(env.CATALOGUE_DB, {
    get(target, property) {
      if (property === "batch")
        return async (...args: Parameters<D1Database["batch"]>) => {
          if (outage) throw new Error("controlled accounting transaction outage after retained upload");
          return target.batch(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await target.put(...args);
          outage = true;
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let calls = 0;
  let bytes: Uint8Array | undefined;
  const input = {
    database: catalogueStore(unreliable),
    evidenceObjects: bucket,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
        bytes = new Uint8Array(await response.arrayBuffer());
        return new Response(bytes, {
          headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) },
        });
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests: await pendingEvidenceRequests(database, runId),
  };
  await expect(collectSourceRequestBatch(input)).rejects.toThrow(
    "controlled accounting transaction outage after retained upload",
  );
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    acquisition: { charged_dispatches: 1, charged_source_bytes: 0, reserved_source_bytes: 16 * 1024 * 1024 },
    snapshots: [],
  });
  outage = false;
  await collectSourceRequestBatch({ ...input, database, evidenceObjects: env.EVIDENCE_OBJECTS });
  expect(calls).toBe(1);
  const shown = await showEvidenceRun(database, runId);
  expect(shown).toMatchObject({
    acquisition: {
      charged_dispatches: 1,
      charged_source_bytes: bytes!.byteLength,
      reserved_source_bytes: 0,
      unsettled: [],
    },
  });
  const snapshots = shown.snapshots as Array<{ content: { object_key: string } }>;
  expect(snapshots).toHaveLength(1);
  const retained = await env.EVIDENCE_OBJECTS.get(snapshots[0]!.content.object_key);
  expect(new Uint8Array(await retained!.arrayBuffer())).toEqual(bytes);
});

test("an ambiguous storage response pauses until the exact late body is verified during ordinary resume", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_late_storage_001",
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  const release = acquisitionBarrier();
  let late: Promise<unknown> | undefined;
  let bytes: Uint8Array | undefined;
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const body = new Uint8Array(await new Response(args[1] as ReadableStream<Uint8Array>).arrayBuffer());
          late = release.promise.then(() => target.put(args[0], body, args[2]));
          throw new Error("controlled ambiguous storage acknowledgement before late completion");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await collectSourceRequestBatch({
      database,
      evidenceObjects: bucket,
      officialSourceTransport: {
        fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
          const response = await env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
          bytes = new Uint8Array(await response.arrayBuffer());
          return new Response(bytes, {
            headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) },
          });
        },
      } as Fetcher,
      runId,
      hostname: "acquisition-official-source.invalid",
      pacingMode: "immediate",
      pacingIntervalMilliseconds: 0,
      requests: await pendingEvidenceRequests(database, runId),
    });
    expect(await showEvidenceRun(database, runId)).toMatchObject({
      state: "paused",
      pause: { reason: "source_acquisition_budget_exhausted", dimension: "ownership" },
      acquisition: { charged_dispatches: 1, charged_source_bytes: 0, reserved_source_bytes: 16 * 1024 * 1024 },
      snapshots: [],
    });
    const premature = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/resume`, "POST");
    expect(premature.status).toBe(409);
    await premature.body?.cancel();
  } finally {
    release.resolve();
    await late;
  }
  const resumed = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const completed = await waitForEvidenceCondition(runId, (current) => current.collection_completed_at !== null);
  expect(completed).toMatchObject({
    acquisition: { charged_dispatches: 1, charged_source_bytes: bytes!.byteLength, reserved_source_bytes: 0 },
  });
  expect(completed.snapshots).toHaveLength(1);
  expect(
    new Uint8Array(await (await env.EVIDENCE_OBJECTS.get(completed.snapshots[0]!.content.object_key))!.arrayBuffer()),
  ).toEqual(bytes);
});
