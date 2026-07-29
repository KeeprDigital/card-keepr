import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { captureOperationIdentity } from "../../../src/catalogue/source-evidence-capture";
import { sourceAdapterRegistrations } from "../../../src/catalogue/source-adapters";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeEach(async () => {
  await applyD1Migrations(
    env.CATALOGUE_DB,
    env.TEST_MIGRATIONS,
  );
  // Workflow instances outlive a Vitest request isolate. Reset only the
  // singleton lock so each test begins with an independent administration
  // scenario; production never performs this test-only setup.
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
});

test("the administration authentication boundary runs in the Workers runtime", async () => {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: "Bearer vitest-administration-key" },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "ingestion",
    status: "ok",
  });
});

test("a successful Official Source response is snapshotted before parsing", async () => {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "one-piece-json-document@1",
      idempotency_key: "source_collection_success_001",
      requests: [
        {
          id: "cards",
          url: "https://official-source.invalid/cards",
        },
      ],
    },
  );
  expect(created.status).toBe(201);
  const planned = await created.json<{
    id: string;
    state: string;
  }>();
  expect(planned.state).toBe("collecting");
  const lifecycle = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}`,
    "GET",
  );
  expect(lifecycle.status).toBe(200);
  await expect(lifecycle.json()).resolves.toMatchObject({
    id: planned.id,
    state: "collecting",
    selected_games: ["one-piece"],
  });

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{
    ingestion_run_id: string;
    workflow: { id: string; status: string };
  }>();
  expect(accepted).toMatchObject({
    ingestion_run_id: planned.id,
    workflow: {
      status: expect.stringMatching(/^(queued|running|waiting|complete)$/),
    },
  });
  const replayedResume = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/collection/resume`,
    "POST",
  );
  expect(replayedResume.status).toBe(202);
  await expect(replayedResume.json()).resolves.toMatchObject({
    ingestion_run_id: planned.id,
    workflow: { id: accepted.workflow.id },
  });

  const completed = await waitForEvidenceRun(
    planned.id,
    "parsing",
  );

  expect(completed.state).toBe("parsing");
  expect(completed.snapshots).toHaveLength(1);
  const snapshot = completed.snapshots[0];
  if (snapshot === undefined) throw new Error("missing Source Snapshot");
  expect(snapshot).toMatchObject({
    request: {
      method: "GET",
      url: "https://official-source.invalid/cards",
    },
    http: {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: '"cards-v1"',
      },
    },
    adapter_version: "one-piece-json-document@1",
    ingestion_run_id: planned.id,
  });
  expect(snapshot.content).toMatchObject({
    byte_length: 60,
  });
  expect(snapshot.content.digest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(snapshot.content.object_key).toMatch(
    /^source-snapshots\/srcsnap_[A-Za-z0-9-]+\.bin$/,
  );

  expect(completed.observation_sets).toHaveLength(1);
  const observationSet = completed.observation_sets[0];
  if (observationSet === undefined) {
    throw new Error("missing Source Observation set");
  }
  expect(observationSet).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "one-piece-json-document@1",
    observation_count: 1,
  });
  expect(observationSet.content_digest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(observationSet.object_key).toMatch(
    /^source-observations\/srcobsset_[A-Za-z0-9-]+\.json$/,
  );

  const snapshotContent = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/content`,
    "GET",
  );
  expect(snapshotContent.status).toBe(200);
  expect(snapshotContent.headers.get("etag")).toBe(
    `"sha256-${snapshot.content.digest}"`,
  );
  await expect(snapshotContent.text()).resolves.toBe(
    '{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}',
  );

  const observationContent = await administrationRequest(
    `/v1/source-observation-sets/${observationSet.id}/content`,
    "GET",
  );
  expect(observationContent.status).toBe(200);
  const observationDocument = await observationContent.json<{
    source_snapshot_id: string;
    adapter_version: string;
    observations: unknown[];
  }>();
  expect(observationDocument).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "one-piece-json-document@1",
  });
  expect(observationDocument.observations).toHaveLength(1);

  const shown = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/evidence`,
    "GET",
  );
  expect(shown.status).toBe(200);
  await expect(shown.json()).resolves.toEqual(completed);
});

test("redirects and terminal HTTP failures remain diagnostics without Source Snapshots", async () => {
  const redirectRun = await createCollection(
    "source_collection_redirect_001",
    "https://official-source.invalid/redirect",
  );
  const rejectedResponse = await administrationRequest(
    `/v1/ingestion-runs/${redirectRun.id}/collection/resume`,
    "POST",
  );
  expect(rejectedResponse.status).toBe(202);
  await rejectedResponse.body?.cancel();
  const rejected = await waitForEvidenceRun(
    redirectRun.id,
    "failed",
  ) as CollectionDocument;
  expect(rejected).toMatchObject({
    state: "failed",
    failure_code: "source_redirect_rejected",
    snapshots: [],
  });
  expect(rejected.diagnostics).toHaveLength(1);
  expect(rejected.diagnostics[0]).toMatchObject({
    attempt_number: 1,
    outcome: "redirect",
    http_status: 302,
  });

  const failedRun = await createCollection(
    "source_collection_failed_001",
    "https://failed-official-source.invalid/unavailable",
  );
  const failedResponse = await administrationRequest(
    `/v1/ingestion-runs/${failedRun.id}/collection/resume`,
    "POST",
  );
  expect(failedResponse.status).toBe(202);
  await failedResponse.body?.cancel();
  const failed = await waitForEvidenceRun(
    failedRun.id,
    "failed",
    12_000,
  ) as CollectionDocument;
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(failed.diagnostics).toHaveLength(4);
  expect(
    failed.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
      status: diagnostic.http_status,
      retry_after_ms: diagnostic.retry_after_ms,
    })),
  ).toEqual([
    {
      attempt_number: 1,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 2,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 3,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 4,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
  ]);

  const retriedResponse = await administrationRequest(
    `/v1/ingestion-runs/${failed.id}/collection/retry`,
    "POST",
    { idempotency_key: "source_collection_failed_retry_001" },
  );
  expect(retriedResponse.status).toBe(201);
  const retried = await retriedResponse.json<CollectionDocument>();
  expect(retried).toMatchObject({
    state: "collecting",
    linked_run_id: failed.id,
    snapshots: [],
    diagnostics: [],
  });
  expect(retried.id).not.toBe(failed.id);
});

test(
  "successful captures remain auditable when a later required response is rejected or terminally fails",
  async () => {
    for (const scenario of [
      {
        key: "retained_after_rejected_001",
        terminalUrl:
          "https://retained-redirect-official-source.invalid/redirect",
        failureCode: "source_redirect_rejected",
      },
      {
        key: "retained_after_terminal_failure_001",
        terminalUrl:
          "https://retained-failure-official-source.invalid/unavailable",
        failureCode: "source_request_retries_exhausted",
      },
    ]) {
      const response = await administrationRequest(
        "/v1/ingestion-runs/evidence",
        "POST",
        {
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "one-piece-json-document@1",
          idempotency_key: scenario.key,
          requests: [
            {
              id: "captured",
              url: `https://${new URL(scenario.terminalUrl).hostname}/cards`,
            },
            { id: "terminal", url: scenario.terminalUrl },
          ],
        },
      );
      const run = await response.json<{ id: string }>();
      const terminal = await resumeCollection(run.id);
      expect(terminal).toMatchObject({
        state: "failed",
        failure_code: scenario.failureCode,
      });
      expect(terminal.snapshots).toHaveLength(1);
      expect(terminal.observation_sets).toHaveLength(1);

      const retained = await showCollection(run.id);
      expect(retained.snapshots).toEqual(terminal.snapshots);
      expect(retained.observation_sets).toEqual(
        terminal.observation_sets,
      );
    }
  },
  12_000,
);

test("a successful response remains snapshotted when parsing terminally fails", async () => {
  const run = await createCollection(
    "source_collection_parse_failure_001",
    "https://parse-failure-official-source.invalid/invalid-json",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const failed = await waitForEvidenceRun(run.id, "failed", 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  expect(failed.snapshots).toHaveLength(1);
  expect(failed.observation_sets).toEqual([]);
  expect(failed.diagnostics).toHaveLength(1);
  expect(failed.diagnostics[0]).toMatchObject({
    outcome: "success",
    http_status: 200,
  });

  const retained = await showCollection(run.id);
  expect(retained.snapshots).toEqual(failed.snapshots);
});

test("validator revalidation creates fresh fetch evidence and reuses bytes only for the same adapter version", async () => {
  const firstRun = await createCollection(
    "source_collection_cache_first_001",
    "https://official-source.invalid/conditional",
    "one-piece-json-document@1",
    { "accept-language": "en" },
  );
  const first = await resumeCollection(firstRun.id);
  const firstSnapshot = first.snapshots[0];
  if (firstSnapshot === undefined) throw new Error("missing first snapshot");
  await releaseActiveRunForNextScenario();

  const differentRepresentationRun = await createCollection(
    "source_collection_cache_language_changed_001",
    "https://official-source.invalid/conditional",
    "one-piece-json-document@1",
    { "accept-language": "fr" },
  );
  const differentRepresentation = await resumeCollection(
    differentRepresentationRun.id,
  );
  expect(differentRepresentation.snapshots[0]).toMatchObject({
    http: { status: 200 },
    reused_source_snapshot_id: null,
  });
  await releaseActiveRunForNextScenario();

  const revalidatedRun = await createCollection(
    "source_collection_cache_second_001",
    "https://official-source.invalid/conditional",
    "one-piece-json-document@1",
    { "accept-language": "en" },
  );
  const revalidated = await resumeCollection(revalidatedRun.id);
  const revalidatedSnapshot = revalidated.snapshots[0];
  if (revalidatedSnapshot === undefined) {
    throw new Error("missing revalidated snapshot");
  }
  await releaseActiveRunForNextScenario();
  expect(revalidatedSnapshot).toMatchObject({
    http: { status: 304 },
    reused_source_snapshot_id: firstSnapshot.id,
    content: {
      digest: firstSnapshot.content.digest,
      object_key: firstSnapshot.content.object_key,
    },
  });
  expect(revalidated.diagnostics[0]).toMatchObject({
    outcome: "cache_revalidated",
    http_status: 304,
  });

  const changedAdapterRun = await createCollection(
    "source_collection_cache_adapter_changed_001",
    "https://official-source.invalid/conditional",
    "one-piece-json-document@2",
    { "accept-language": "en" },
  );
  const changedAdapter = await resumeCollection(changedAdapterRun.id);
  const changedAdapterSnapshot = changedAdapter.snapshots[0];
  if (changedAdapterSnapshot === undefined) {
    throw new Error("missing changed-adapter snapshot");
  }
  expect(changedAdapterSnapshot.http.status).toBe(200);
  expect(changedAdapterSnapshot.reused_source_snapshot_id).toBeNull();
}, 12_000);

test("Retry-After is audited without shortening the Official Source deadline", async () => {
  const run = await createCollection(
    "source_retry_after_long_001",
    "https://retry-after-official-source.invalid/retry-after-long",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const waiting = await waitForEvidenceDiagnostic(run.id);
  expect(waiting).toMatchObject({
    state: "collecting",
    diagnostics: [
      {
        attempt_number: 1,
        outcome: "http_failure",
        http_status: 503,
        retry_after_ms: 120_000,
      },
    ],
  });
  const childWorkflowId = waiting.workflow.child_ids[0];
  if (childWorkflowId === undefined) {
    throw new Error("missing hostname Workflow identity");
  }
  const childWorkflow = await env.EVIDENCE_HOST_WORKFLOW.get(childWorkflowId);
  await childWorkflow.terminate();
});

test("adapter versions are bound to one Supported Game, Game Profile, and source lineage", async () => {
  const mismatched = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "unrelated-source",
      adapter_version: "one-piece-json-document@1",
      idempotency_key: "source_adapter_mismatch_001",
      requests: [
        {
          id: "cards",
          url: "https://official-source.invalid/cards",
        },
      ],
    },
  );
  expect(mismatched.status).toBe(422);
  await expect(mismatched.json()).resolves.toMatchObject({
    code: "adapter_binding_mismatch",
  });

  const constrained = await env.CATALOGUE_DB.prepare(
    `SELECT adapter_version, source_lineage, supported_game,
            game_profile_version
     FROM source_adapter_versions ORDER BY adapter_version`,
  ).all<{
    adapter_version: string;
    source_lineage: string;
    supported_game: string;
    game_profile_version: string;
  }>();
  expect(constrained.results).toEqual(
    sourceAdapterRegistrations
      .map((adapter) => ({
        adapter_version: adapter.adapterVersion,
        source_lineage: adapter.sourceLineage,
        supported_game: adapter.supportedGame,
        game_profile_version: adapter.gameProfileVersion,
      }))
      .sort((left, right) =>
        left.adapter_version.localeCompare(right.adapter_version),
      ),
  );
});

test("all successful response bytes stream to immutable storage while parsing stays bounded", async () => {
  const retainedRun = await createCollection(
    "source_large_parse_bound_001",
    "https://large-official-source.invalid/large-json",
  );
  const retained = await resumeCollection(retainedRun.id);
  expect(retained).toMatchObject({
    state: "failed",
    failure_code: "source_parse_too_large",
  });
  expect(retained.snapshots).toHaveLength(1);
  expect(retained.snapshots[0]!.content.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(retained.snapshots[0]!.content.byte_length).toBeGreaterThan(
    1024 * 1024,
  );
  expect(retained.observation_sets).toEqual([]);

  const hugeRun = await createCollection(
    "source_huge_capture_001",
    "https://large-official-source.invalid/huge-json",
  );
  const huge = await resumeCollection(hugeRun.id);
  expect(huge).toMatchObject({
    state: "failed",
    failure_code: "source_parse_too_large",
  });
  expect(huge.snapshots).toHaveLength(1);
  expect(huge.snapshots[0]!.content.byte_length).toBeGreaterThan(
    32 * 1024 * 1024,
  );
  expect(huge.snapshots[0]!.content.digest).toMatch(/^[a-f0-9]{64}$/);
}, 15_000);

test("body streaming failures are durable diagnostics with bounded retries", async () => {
  const run = await createCollection(
    "source_body_failure_001",
    "https://body-failure-official-source.invalid/body-failure",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const failed = await waitForEvidenceRun(run.id, "failed", 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(failed.diagnostics).toHaveLength(4);
  expect(
    failed.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
    })),
  ).toEqual([
    { attempt_number: 1, outcome: "body_failure" },
    { attempt_number: 2, outcome: "body_failure" },
    { attempt_number: 3, outcome: "body_failure" },
    { attempt_number: 4, outcome: "body_failure" },
  ]);
}, 15_000);

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

test("reparsing appends an immutable observation set tied to the exact Source Snapshot", async () => {
  const run = await createCollection(
    "source_collection_reparse_001",
    "https://official-source.invalid/cards",
  );
  const completed = await resumeCollection(run.id);
  const snapshot = completed.snapshots[0];
  const originalSet = completed.observation_sets[0];
  if (snapshot === undefined || originalSet === undefined) {
    throw new Error("missing evidence for reparse");
  }

  const reparseResponse = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    "POST",
    { adapter_version: "one-piece-json-document@2" },
  );
  expect(reparseResponse.status).toBe(201);
  const reparsed = await reparseResponse.json<ObservationSet>();
  expect(reparsed).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "one-piece-json-document@2",
    observation_count: 1,
  });
  expect(reparsed.id).not.toBe(originalSet.id);
  expect(reparsed.object_key).not.toBe(originalSet.object_key);

  const shown = await showCollection(run.id);
  expect(shown.observation_sets).toHaveLength(2);
  expect(shown.observation_sets[0]).toEqual(originalSet);
  expect(shown.observation_sets[1]).toEqual(reparsed);
});

test("collection is sequential per hostname and different hostnames progress concurrently", async () => {
  const response = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "one-piece-json-document@1",
      idempotency_key: "source_collection_pacing_001",
      requests: [
        {
          id: "first-a",
          url: "https://pacing-a-official-source.invalid/sequence/1",
        },
        {
          id: "second-a",
          url: "https://pacing-a-official-source.invalid/sequence/2",
        },
        {
          id: "first-b",
          url: "https://pacing-b-official-source.invalid/sequence/1",
        },
        {
          id: "second-b",
          url: "https://pacing-b-official-source.invalid/sequence/2",
        },
      ],
    },
  );
  const run = await response.json<{ id: string }>();
  const completed = await resumeCollection(run.id);
  expect(completed.state).toBe("parsing");
  const attempts = Object.fromEntries(
    completed.diagnostics.map((attempt) => [
      attempt.request_id,
      Date.parse(attempt.requested_at),
    ]),
  );
  expect(attempts["second-a"]! - attempts["first-a"]!).toBeGreaterThanOrEqual(
    1_000,
  );
  expect(attempts["second-b"]! - attempts["first-b"]!).toBeGreaterThanOrEqual(
    1_000,
  );
  expect(
    Math.abs(attempts["first-a"]! - attempts["first-b"]!),
  ).toBeLessThan(500);
});

function administrationRequest(
  pathname: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method,
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `192.0.2.${crypto.getRandomValues(new Uint8Array(1))[0]!}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

type Snapshot = {
  id: string;
  request: { method: string; url: string };
  retrieval: { retrieved_at: string; fetch_attempt_id: string };
  http: { status: number; headers: Record<string, string> };
  content: { digest: string; object_key: string; byte_length: number };
  adapter_version: string;
  ingestion_run_id: string;
  reused_source_snapshot_id: string | null;
};

type ObservationSet = {
  id: string;
  source_snapshot_id: string;
  adapter_version: string;
  content_digest: string;
  object_key: string;
  observation_count: number;
};

type Diagnostic = {
  request_id: string;
  attempt_number: number;
  requested_at: string;
  outcome: string;
  http_status: number | null;
  retry_after_ms: number | null;
};

type CollectionDocument = {
  id: string;
  state: string;
  linked_run_id: string | null;
  failure_code: string | null;
  snapshots: Snapshot[];
  observation_sets: ObservationSet[];
  diagnostics: Diagnostic[];
  workflow: { parent_id: string | null; child_ids: string[] };
};

async function createCollection(
  idempotencyKey: string,
  url: string,
  adapterVersion = "one-piece-json-document@1",
  headers: Record<string, string> = {},
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: adapterVersion,
      idempotency_key: idempotencyKey,
      requests: [{ id: "required-source", url, headers }],
    },
  );
  expect(response.status).toBe(201);
  return response.json<CollectionDocument>();
}

async function waitForEvidenceDiagnostic(
  runId: string,
  timeoutMs = 2_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (current.diagnostics.length > 0) return current;
    if (Date.now() >= deadline) {
      throw new Error(`Ingestion Run ${runId} did not record a diagnostic`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function resumeCollection(
  runId: string,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    "POST",
  );
  expect(response.status).toBe(202);
  await response.body?.cancel();
  return waitForEvidenceRun(runId);
}

async function waitForEvidenceRun(
  runId: string,
  expectedState: "parsing" | "failed" | null = null,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (
      expectedState === null
        ? current.state === "parsing" || current.state === "failed"
        : current.state === expectedState
    ) {
      return current;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Ingestion Run ${runId} did not reach ${expectedState ?? "a terminal collection-phase state"}; current state is ${current.state}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function releaseActiveRunForNextScenario(): Promise<D1Result<unknown>> {
  return env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
}

async function showCollection(
  runId: string,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/evidence`,
    "GET",
  );
  expect(response.status).toBe(200);
  return response.json<CollectionDocument>();
}
