import { beginEvidenceObjectWrite } from "../../../src/catalogue/source-evidence/evidence-cleanup-repository";
import { catalogueStore } from "../../../src/catalogue/shared";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import { rawWriterCompletion } from "./query-helpers/acquisition-recovery";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  captureOperationIdentity,
  capturePreparedAttempt,
  prepareCaptureAttempt,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import {
  administrationRequest,
  createCollection,
  installRuntimeSuite,
  type ObservationSet,
  resumeCollection,
  showCollection,
} from "./runtime-helpers";

installRuntimeSuite();

test("an untracked response receipt pauses on a storage outage and cannot infer fresh dispatch authority", async () => {
  const run = await createCollection("source_recovery_r2_outage_001", "https://official-source.invalid/cards");
  const database = catalogueStore(env.CATALOGUE_DB);
  const identity = await captureOperationIdentity(run.id, "one-piece-en:discovery", 1);
  const now = new Date().toISOString();
  await sourceEvidenceQueries
    .insertSourceCaptureOperationsForR2RecoveryOutagesPauseRunResumeCompletesSameCapture(env.CATALOGUE_DB)
    .bind(identity.attemptId, run.id, identity.snapshotId, identity.objectKey, now, now)
    .run();
  const outageBucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async () => {
          throw new Error("synthetic R2 outage");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const evidenceRun = await requiredEvidenceRun(database, run.id);
  const request = (await pendingEvidenceRequests(database, run.id))[0]!;
  const prepared = await prepareCaptureAttempt(database, evidenceRun, request);
  if (prepared.kind !== "attempt") throw new Error("Expected a retained capture");
  expect(
    await capturePreparedAttempt(database, outageBucket, env.OFFICIAL_SOURCE_TRANSPORT, evidenceRun, request, prepared),
  ).toMatchObject({ kind: "done", request_made: false });
  expect(await showCollection(run.id)).toMatchObject({
    state: "paused",
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "ownership" },
    snapshots: [],
  });
  expect(await pendingEvidenceRequests(database, run.id)).toEqual([request]);
  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(409);
  expect(await resumed.json()).toMatchObject({ code: "source_acquisition_ownership_pending" });
});

test("an observed object cannot settle untracked or unrelated physical writer identities", async () => {
  const run = await createCollection(
    "source_restart_boundary_001",
    "https://restart-official-source.invalid/must-not-refetch",
  );
  const identity = await captureOperationIdentity(run.id, "one-piece-en:discovery", 1);
  const bytes = new TextEncoder().encode('{"cards":[{"card_number":"OP01-001"}]}');
  await beginEvidenceObjectWrite(
    catalogueStore(env.CATALOGUE_DB),
    "observed-restart-writer",
    run.id,
    identity.objectKey,
    new Date().toISOString(),
  ).run();
  await beginEvidenceObjectWrite(
    catalogueStore(env.CATALOGUE_DB),
    "unrelated-restart-writer",
    run.id,
    identity.objectKey,
    new Date().toISOString(),
  ).run();
  await env.EVIDENCE_OBJECTS.put(identity.objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: { cleanup_writer_token: "observed-restart-writer" },
  });
  const now = new Date().toISOString();
  await sourceEvidenceQueries
    .insertSourceCaptureOperationsForR2RecoveryOutagesPauseRunResumeCompletesSameCapture(env.CATALOGUE_DB)
    .bind(identity.attemptId, run.id, identity.snapshotId, identity.objectKey, now, now)
    .run();

  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(409);
  expect(await resumed.json()).toMatchObject({ code: "source_acquisition_ownership_pending" });
  expect(await showCollection(run.id)).toMatchObject({ snapshots: [], diagnostics: [] });
  expect(new Uint8Array(await (await env.EVIDENCE_OBJECTS.get(identity.objectKey))!.arrayBuffer())).toEqual(bytes);
  for (const token of ["observed-restart-writer", "unrelated-restart-writer"]) {
    expect(await rawWriterCompletion(env.CATALOGUE_DB, token).first()).toMatchObject({ completed_at: null });
  }
});

test("reparse retries recover one staged immutable observation set while new intents append", async () => {
  const run = await createCollection(
    "source_collection_reparse_001",
    "https://official-source.invalid/raw-one-piece-products",
  );
  const completed = await resumeCollection(run.id);
  const snapshot = completed.snapshots[0];
  const originalSet = completed.observation_sets[0];
  if (snapshot === undefined || originalSet === undefined) {
    throw new Error("missing evidence for reparse");
  }
  const objectsBeforeReparse = new Set(
    (
      await env.EVIDENCE_OBJECTS.list({
        prefix: "source-observations/",
      })
    ).objects.map((object) => object.key),
  );

  await sourceEvidenceQueries.createFailObservationSetInsert(env.CATALOGUE_DB).run();
  const interrupted = await administrationRequest(`/v1/source-snapshots/${snapshot.id}/observations`, "POST", {
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "reparse_intent_001",
  });
  expect(interrupted.status).toBe(500);
  const staged = await sourceEvidenceQueries
    .readSourceParseOperationsStateContentObjectKey(env.CATALOGUE_DB)
    .bind(snapshot.id, "fixture-one-piece-json@3", "reparse_intent_001")
    .first<{ state: string; content_object_key: string }>();
  expect(staged?.state).toBe("uploaded");
  expect(await env.EVIDENCE_OBJECTS.head(staged!.content_object_key)).not.toBeNull();
  await publishedCatalogueQueries.dropFailObservationSetInsert(env.CATALOGUE_DB).run();

  const retriedResponses = await Promise.all([
    administrationRequest(`/v1/source-snapshots/${snapshot.id}/observations`, "POST", {
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: "reparse_intent_001",
    }),
    administrationRequest(`/v1/source-snapshots/${snapshot.id}/observations`, "POST", {
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: "reparse_intent_001",
    }),
  ]);
  expect(retriedResponses.map((response) => response.status)).toEqual([201, 201]);
  const [reparsed, replayed] = await Promise.all(retriedResponses.map((response) => response.json<ObservationSet>()));
  if (reparsed === undefined || replayed === undefined) {
    throw new Error("missing replayed Source Observation Set");
  }
  expect(reparsed).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fixture-one-piece-json@3",
    observation_count: 1,
  });
  expect(replayed).toEqual(reparsed);
  expect(reparsed.id).not.toBe(originalSet.id);
  expect(reparsed.object_key).not.toBe(originalSet.object_key);

  const appendedResponse = await administrationRequest(`/v1/source-snapshots/${snapshot.id}/observations`, "POST", {
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "reparse_intent_002",
  });
  expect(appendedResponse.status).toBe(201);
  const appended = await appendedResponse.json<ObservationSet>();
  expect(appended.id).not.toBe(reparsed.id);

  const shown = await showCollection(run.id);
  expect(shown.observation_sets).toHaveLength(3);
  expect(shown.observation_sets).toEqual([originalSet, reparsed, appended]);
  const objects = await env.EVIDENCE_OBJECTS.list({
    prefix: "source-observations/",
  });
  expect(
    objects.objects
      .map((object) => object.key)
      .filter((key) => !objectsBeforeReparse.has(key))
      .sort(),
  ).toEqual([reparsed, appended].map((set) => set.object_key).sort());
});

test("reparse observes and settles the exact writer after a lost successful put response", async () => {
  const run = await createCollection("source_parse_lost_put", "https://official-source.invalid/raw-one-piece-products");
  const completed = await resumeCollection(run.id);
  const snapshot = completed.snapshots[0];
  if (!snapshot) throw new Error("missing snapshot");
  const { reparseSourceSnapshot } = await import("../../../src/catalogue/source-evidence");
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          await target.put(...args);
          throw new Error("synthetic lost successful put response");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    reparseSourceSnapshot(
      catalogueStore(env.CATALOGUE_DB),
      bucket,
      snapshot.id,
      "fixture-one-piece-json@3",
      "lost-parse-put",
    ),
  ).rejects.toThrow("synthetic lost successful put response");
  expect(
    await env.CATALOGUE_DB.prepare(
      "SELECT count(*) AS n FROM evidence_object_writers WHERE ingestion_run_id=? AND completed_at IS NULL",
    )
      .bind(run.id)
      .first(),
  ).toMatchObject({ n: 1 });
  await reparseSourceSnapshot(
    catalogueStore(env.CATALOGUE_DB),
    env.EVIDENCE_OBJECTS,
    snapshot.id,
    "fixture-one-piece-json@3",
    "lost-parse-put",
  );
  expect(
    await env.CATALOGUE_DB.prepare(
      "SELECT count(*) AS n FROM evidence_object_writers WHERE ingestion_run_id=? AND completed_at IS NULL",
    )
      .bind(run.id)
      .first(),
  ).toMatchObject({ n: 0 });
});

test.each([
  [0, false],
  [2, false],
  [2, true],
] as const)(
  "a conditional capture loser preserves the other writer (%s bytes, lost acknowledgement %s)",
  async (size, lostAcknowledgement) => {
    const run = await createCollection(
      `source_conditional_loser_${size}_${lostAcknowledgement}`,
      "https://official-source.invalid/cards",
    );
    const db = catalogueStore(env.CATALOGUE_DB);
    const evidenceRun = await requiredEvidenceRun(db, run.id);
    const request = (await pendingEvidenceRequests(db, run.id))[0]!;
    const prepared = await prepareCaptureAttempt(db, evidenceRun, request);
    if (prepared.kind !== "attempt") throw new Error("missing prepared capture");
    const winner = `conditional-winner-${size}`;
    const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
      get(target, property) {
        if (property === "put")
          return async (key: string, body: unknown) => {
            // Cancellation with either a null or lost storage acknowledgement
            // must not delete the concurrent winner.
            await beginEvidenceObjectWrite(db, winner, run.id, key, new Date().toISOString()).run();
            await target.put(key, size ? "{}" : "", { customMetadata: { cleanup_writer_token: winner } });
            if (body instanceof ReadableStream) await body.cancel("conditional request did not consume the body");
            if (lostAcknowledgement) throw new Error("conditional storage acknowledgement lost");
            return null;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const transport = new Proxy(env.OFFICIAL_SOURCE_TRANSPORT, {
      get(target, property) {
        if (property === "fetch")
          return async () =>
            new Response(size ? "{}" : null, {
              headers: { "content-type": "application/json", "content-length": String(size) },
            });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await capturePreparedAttempt(db, bucket, transport, evidenceRun, request, prepared);
    expect(result.kind).toBe("done");
    expect(await showCollection(run.id)).toMatchObject({
      state: "paused",
      pause: { dimension: "ownership" },
      snapshots: [],
    });
    expect((await env.EVIDENCE_OBJECTS.head(prepared.content_object_key))?.size).toBe(size);
    expect(
      await env.CATALOGUE_DB.prepare(
        "SELECT count(*) AS n FROM evidence_object_writers WHERE ingestion_run_id=? AND completed_at IS NULL",
      )
        .bind(run.id)
        .first(),
    ).toMatchObject({ n: lostAcknowledgement ? 2 : 1 });
  },
);
