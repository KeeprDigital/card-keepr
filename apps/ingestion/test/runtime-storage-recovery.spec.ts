import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  captureOperationIdentity,
  capturePreparedAttempt,
  prepareCaptureAttempt,
} from "../../../src/catalogue/source-evidence-capture";
import {
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  administrationRequest,
  createCollection,
  installRuntimeSuite,
  type ObservationSet,
  resumeCollection,
  showCollection,
} from "./runtime-helpers";

installRuntimeSuite();

test("R2 recovery outages pause the run and resume completes the same capture", async () => {
  const run = await createCollection(
    "source_recovery_r2_outage_001",
    "https://official-source.invalid/cards",
  );
  const identity = await captureOperationIdentity(
    run.id,
    "required-source",
    1,
  );
  const now = new Date().toISOString();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations (
      attempt_id, ingestion_run_id, request_id, attempt_number,
      source_snapshot_id, content_object_key, state, requested_at,
      completed_at, request_headers_json, http_status,
      response_headers_json, response_vary_json, media_type
    ) VALUES (
      ?, ?, 'required-source', 1, ?, ?, 'response_received', ?,
      ?, '{}', 200, '{"content-type":"application/json"}', '[]',
      'application/json'
    )`,
  )
    .bind(
      identity.attemptId,
      run.id,
      identity.snapshotId,
      identity.objectKey,
      now,
      now,
    )
    .run();
  const outageBucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (
        property === "get" ||
        property === "put" ||
        property === "createMultipartUpload"
      ) {
        return async () => {
          throw new Error("synthetic R2 outage");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const evidenceRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const request = (
    await pendingEvidenceRequests(env.CATALOGUE_DB, run.id)
  )[0];
  if (request === undefined) throw new Error("missing evidence request");

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const prepared = await prepareCaptureAttempt(
      env.CATALOGUE_DB,
      evidenceRun,
      request,
    );
    if (prepared.kind !== "attempt") {
      throw new Error(`unexpected preparation result ${prepared.kind}`);
    }
    const result = await capturePreparedAttempt(
      env.CATALOGUE_DB,
      outageBucket,
      env.OFFICIAL_SOURCE_TRANSPORT,
      evidenceRun,
      request,
      prepared,
    );
    expect(result.kind).toBe(attempt === 4 ? "done" : "wait");
  }

  // Exhausting the bounded storage retries pauses the run with its own
  // reason instead of failing the request: transient R2 problems do not
  // destroy the collection attempt.
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state FROM ingestion_runs WHERE id = ?",
  ).bind(run.id).first("state")).toBe("paused");
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT pause_reason, failure_classification, retry_generation
     FROM ingestion_run_retry_pauses WHERE ingestion_run_id = ?`,
  ).bind(run.id).first()).toMatchObject({
    pause_reason: "source_storage_retries_exhausted",
    failure_classification: "storage_failure",
    retry_generation: 1,
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT state, failure_code FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = 'required-source'`,
  ).bind(run.id).first()).toMatchObject({
    state: "pending",
    failure_code: null,
  });

  // Resuming against the recovered bucket opens generation 2; attempt 5
  // captures and the same run completes collection.
  const completed = await resumeCollection(run.id);
  expect(completed).toMatchObject({
    state: "parsing",
    failure_code: null,
  });
  expect(completed.snapshots).toHaveLength(1);
  expect(
    completed.diagnostics.map((diagnostic) => diagnostic.outcome),
  ).toEqual([
    "storage_failure",
    "storage_failure",
    "storage_failure",
    "storage_failure",
    "success",
  ]);
});

test("resume recovers the deterministic object after an upload-before-D1 restart boundary", async () => {
  const run = await createCollection(
    "source_restart_boundary_001",
    "https://restart-official-source.invalid/must-not-refetch",
  );
  const identity = await captureOperationIdentity(
    run.id,
    "required-source",
    1,
  );
  const bytes = new TextEncoder().encode(
    '{"cards":[{"card_number":"OP01-001"}]}',
  );
  await env.EVIDENCE_OBJECTS.put(identity.objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  const now = new Date().toISOString();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations (
      attempt_id, ingestion_run_id, request_id, attempt_number,
      source_snapshot_id, content_object_key, state, requested_at,
      completed_at, request_headers_json, http_status,
      response_headers_json, response_vary_json, media_type
    ) VALUES (
      ?, ?, 'required-source', 1, ?, ?, 'response_received', ?,
      ?, '{}', 200, '{"content-type":"application/json"}', '[]',
      'application/json'
    )`,
  )
    .bind(
      identity.attemptId,
      run.id,
      identity.snapshotId,
      identity.objectKey,
      now,
      now,
    )
    .run();

  const completed = await resumeCollection(run.id);
  expect(completed).toMatchObject({
    state: "parsing",
    diagnostics: [{ attempt_number: 1, outcome: "success" }],
    snapshots: [
      {
        id: identity.snapshotId,
        content: { object_key: identity.objectKey },
      },
    ],
  });
  const operation = await env.CATALOGUE_DB.prepare(
    `SELECT state, content_digest, content_byte_length
     FROM source_capture_operations WHERE attempt_id = ?`,
  )
    .bind(identity.attemptId)
    .first<{
      state: string;
      content_digest: string;
      content_byte_length: number;
    }>();
  expect(operation).toMatchObject({
    state: "finalized",
    content_byte_length: bytes.byteLength,
    content_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await env.EVIDENCE_OBJECTS.head(identity.objectKey)).not.toBeNull();
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

  await env.CATALOGUE_DB.prepare(
    `CREATE TRIGGER fail_observation_set_insert
     BEFORE INSERT ON source_observation_sets
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_observation_d1_outage');
     END`,
  ).run();
  const interrupted = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    "POST",
    {
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: "reparse_intent_001",
    },
  );
  expect(interrupted.status).toBe(500);
  const staged = await env.CATALOGUE_DB.prepare(
    `SELECT state, content_object_key FROM source_parse_operations
     WHERE source_snapshot_id = ? AND adapter_version = ?
       AND idempotency_key = ?`,
  )
    .bind(snapshot.id, "fixture-one-piece-json@3", "reparse_intent_001")
    .first<{ state: string; content_object_key: string }>();
  expect(staged?.state).toBe("uploaded");
  expect(
    await env.EVIDENCE_OBJECTS.head(staged!.content_object_key),
  ).not.toBeNull();
  await env.CATALOGUE_DB.prepare(
    "DROP TRIGGER fail_observation_set_insert",
  ).run();

  const retriedResponses = await Promise.all([
    administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "fixture-one-piece-json@3",
        idempotency_key: "reparse_intent_001",
      },
    ),
    administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "fixture-one-piece-json@3",
        idempotency_key: "reparse_intent_001",
      },
    ),
  ]);
  expect(retriedResponses.map((response) => response.status)).toEqual([
    201,
    201,
  ]);
  const [reparsed, replayed] = await Promise.all(
    retriedResponses.map((response) => response.json<ObservationSet>()),
  );
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

  const appendedResponse = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    "POST",
    {
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: "reparse_intent_002",
    },
  );
  expect(appendedResponse.status).toBe(201);
  const appended = await appendedResponse.json<ObservationSet>();
  expect(appended.id).not.toBe(reparsed.id);

  const shown = await showCollection(run.id);
  expect(shown.observation_sets).toHaveLength(3);
  expect(shown.observation_sets).toEqual([
    originalSet,
    reparsed,
    appended,
  ]);
  const objects = await env.EVIDENCE_OBJECTS.list({
    prefix: "source-observations/",
  });
  expect(
    objects.objects
      .map((object) => object.key)
      .filter((key) => !objectsBeforeReparse.has(key))
      .sort(),
  ).toEqual(
    [reparsed, appended]
      .map((set) => set.object_key)
      .sort(),
  );
});
